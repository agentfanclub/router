import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { byokKey } from "../db/schema";
import type { DenyReason, UsageSnapshot } from "../do/user-usage";
import { OpenAiError } from "../http";
import { ApiKeyIdentity, inferenceKeyAuth } from "../middleware/api-key-auth";
import { query, UsageCoordinator, WorkerEnv, WorkerExecution } from "../services";
import { catalog, upstreamKeys, upstreams, type CatalogModel, type ModelCost, type UpstreamRoute } from "../upstreams";
import { decryptSecret } from "../util/secret-box";
import { usageCaptureTransform } from "../util/sse-usage";
import { diagnosticIdentifier, upstreamErrorFields } from "../util/upstream-diagnostics";
import {
  computeCostMicro,
  deriveSessionId,
  estimateCostMicro,
  parseOpenAiUsage,
  type ParsedUsage,
  type RoutePrice,
} from "../util/usage";

type Status = "ok" | "error" | "aborted";

// Upstream statuses meaning "this account cannot serve right now". The next
// route is tried before the client sees anything.
const FAILOVER_STATUSES = [401, 402, 429];

// Club keys tried per route before failing over to the next one.
const KEYS_PER_ROUTE = 3;

// The fields the router reads. Everything else is forwarded untouched.
const ChatFields = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Unknown),
});

const chatError = (status: number, code: string, message: string, requestId?: string) => new OpenAiError({
  status,
  code,
  message,
  type: status === 400 || status === 404 ? "invalid_request_error" : undefined,
  headers: requestId ? { "x-router-request-id": requestId } : undefined,
});

const parseChatRequest = (text: string) => Effect.try(() => JSON.parse(text) as unknown).pipe(
  Effect.flatMap((raw) => Schema.decodeUnknownEffect(ChatFields)(raw).pipe(
    Effect.map((fields) => ({ fields, raw: raw as Record<string, unknown> })),
  )),
  Effect.map(({ fields, raw }) => {
    const maxTokens = raw.max_tokens ?? raw.max_completion_tokens;
    const streamOptions = raw.stream_options as { include_usage?: unknown } | null | undefined;
    return {
      raw,
      model: fields.model,
      messages: fields.messages,
      stream: raw.stream === true,
      maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : undefined,
      clientWantsUsage: streamOptions?.include_usage === true,
    };
  }),
  Effect.mapError(() => chatError(400, "invalid_request", "The request body must be a JSON chat completion with model and messages.")),
);

const toPrice = (cost: ModelCost): RoutePrice => ({ input: cost.input, output: cost.output, cacheRead: cost.cache_read });

// What the club pays for a request on `route`. The user's own key costs the club nothing.
function upstreamPrice(model: CatalogModel, route: UpstreamRoute): RoutePrice {
  if (route === "byok") return { input: 0, output: 0, cacheRead: 0 };
  return toPrice(model.upstream_cost?.[route] ?? model.cost);
}

const handleChat = Effect.fn("chatCompletion")(function* (request: HttpServerRequest.HttpServerRequest) {
  const env = yield* WorkerEnv;
  const execution = yield* WorkerExecution;
  const identity = yield* ApiKeyIdentity;
  const usage = yield* UsageCoordinator;
  const { signal } = yield* HttpServerRequest.toWeb(request);

  const text = yield* request.text.pipe(
    Effect.mapError(() => chatError(400, "invalid_request", "Unable to read the request body.")),
  );
  const chat = yield* parseChatRequest(text);
  const model = catalog[chat.model];
  if (!model) {
    return yield* chatError(404, "model_not_found", `Unknown model '${chat.model}'. Available models: ${Object.keys(catalog).join(", ")}.`);
  }

  // Derived on the server so grouping and cache affinity do not depend on
  // client-supplied session headers.
  const sessionId = deriveSessionId(chat.messages);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const logContext = { requestId, model: chat.model, stream: chat.stream };
  // What the user pays. Reservations and usage caps use it.
  const price = toPrice(model.cost);

  // Club upstreams serving the model with a configured key, in priority
  // order, then the user's own key when it can serve the model.
  const routes: UpstreamRoute[] = model.upstreams.filter((id) => upstreamKeys(env, id).length > 0);
  if (identity.byok && env.BYOK_ENCRYPTION_KEY && model.upstreams.includes("lumen")) routes.push("byok");
  if (routes.length === 0) {
    console.error({ event: "inference_no_upstream", ...logContext });
    return yield* chatError(503, "no_upstream", "No upstream is currently available to serve this request.", requestId);
  }

  const decision = yield* usage.admit({
    requestId,
    sessionId,
    userId: identity.userId,
    apiKeyId: identity.keyId,
    model: chat.model,
    createdAt: startedAt,
    routes,
    reserveMicro: estimateCostMicro({
      inputEstimateTokens: Math.ceil(text.length / 4),
      maxOutputTokens: Math.min(chat.maxTokens ?? model.limit.output, model.limit.output),
    }, price),
    limits: identity.limits,
  }).pipe(Effect.mapError((error) => {
    console.error({ event: "inference_admission_error", ...logContext, errorName: errorName(error.cause) });
    // Fail closed: serving without the coordinator would bypass every limit.
    return chatError(503, "usage_unavailable", "Unable to check usage limits right now. Try again.", requestId);
  }));
  if (decision.decision === "deny") {
    console.info({ event: "inference_denied", ...logContext, reason: decision.reason });
    return limitReached(decision.reason, decision.snapshot, requestId);
  }

  // The route that served the request. Failover can change it, so settlement
  // reads it at completion time.
  let route = decision.route;

  // Only reported usage becomes spend. An interrupted response without usage
  // has an unknown cost and is recorded as zero. Settlement runs detached so
  // it outlives the client connection, which can close as soon as it sees
  // the terminal stream event.
  const finish = (status: Status, parsed: ParsedUsage | null): Promise<void> => {
    const durationMs = Date.now() - startedAt;
    console.info({ event: "inference_finished", ...logContext, route, status, durationMs });
    const settle = usage.settle(identity.userId, {
      requestId, route, status, durationMs,
      usage: parsed,
      chargeMicro: parsed ? computeCostMicro(parsed, price) : 0,
      costMicro: parsed ? computeCostMicro(parsed, upstreamPrice(model, route)) : 0,
      limits: identity.limits,
    });
    const pending = Effect.runPromise(settle.pipe(
      Effect.retry({ times: 1 }),
      Effect.tapError((error) => Effect.sync(() => {
        console.error({ event: "inference_settlement_error", ...logContext, route, errorName: errorName(error.cause) });
      })),
      Effect.ignore,
    ));
    execution.waitUntil(pending);
    return pending;
  };
  const settleNow = (status: Status, parsed: ParsedUsage | null = null) => Effect.promise(() => finish(status, parsed));

  let byokUnreadable = false;

  // The next key to try on a route, or null when the route has none left.
  const nextKey = Effect.fn(function* (candidate: UpstreamRoute, tried: ReadonlySet<string>) {
    if (candidate === "byok") {
      if (tried.size > 0) return null;
      const key = yield* Effect.tryPromise(() => decryptSecret(identity.byok!.ciphertext, env.BYOK_ENCRYPTION_KEY!)).pipe(
        Effect.orElseSucceed(() => null),
      );
      byokUnreadable ||= key === null;
      return key;
    }
    // A random untried key. Random choice evens out across per-key rate
    // limits without tracking usage.
    const keys = upstreamKeys(env, candidate).filter((key) => !tried.has(key));
    return keys.length > 0 ? keys[Math.floor(Math.random() * keys.length)]! : null;
  });

  let attempt = 0;
  const send = (candidate: UpstreamRoute, key: string) => {
    const upstream = upstreams[candidate === "byok" ? "lumen" : candidate];
    const body = { ...chat.raw };
    // Streams always ask for usage so real token counts back the accounting.
    // The extra usage chunk is hidden from clients that did not ask for it.
    if (chat.stream) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    upstream.prepareBody?.(body);

    const attemptContext = { ...logContext, route: candidate, attempt: ++attempt };
    const attemptStartedAt = Date.now();
    console.info({ event: "upstream_started", ...attemptContext });
    return Effect.tryPromise(() => fetch(upstream.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: request.headers.accept ?? "application/json",
        "x-opencode-session": sessionId,
      },
      body: JSON.stringify(body),
      signal,
      redirect: "manual",
    })).pipe(
      Effect.tap((response) => Effect.sync(() => console.info({
        event: "upstream_response", ...attemptContext,
        upstreamStatus: response.status,
        headersMs: Date.now() - attemptStartedAt,
        upstreamRay: diagnosticIdentifier(response.headers.get("cf-ray")),
        upstreamRequestId: diagnosticIdentifier(response.headers.get("x-request-id")),
      }))),
      Effect.tapError((error) => Effect.sync(() => console.error({
        event: "upstream_fetch_error", ...attemptContext,
        elapsedMs: Date.now() - attemptStartedAt,
        clientAborted: signal.aborted,
        errorName: errorName(error.cause),
      }))),
      Effect.orElseSucceed(() => null),
    );
  };

  // A personal key Lumen refuses is marked invalid so later requests stop
  // trying it.
  const invalidateByok = query((db) => db.update(byokKey).set({ status: "invalid" }).where(eq(byokKey.id, identity.byok!.id))).pipe(
    Effect.tapError((error) => Effect.sync(() => console.error({ event: "byok_invalidation_error", ...logContext, errorName: errorName(error.cause) }))),
    Effect.ignore,
  );

  // Start on the admitted route and fail over through the rest in priority
  // order. A request admitted to the user's own key is over the club
  // allowance and never falls back onto a club route.
  const attempts = decision.route === "byok"
    ? ["byok" as const]
    : [decision.route, ...routes.filter((candidate) => candidate !== decision.route)];
  // Within a club route, a refused key is followed by another random key.
  let upstream: Response | null = null;
  routes: for (const candidate of attempts) {
    const tried = new Set<string>();
    while (tried.size < KEYS_PER_ROUTE && !signal.aborted) {
      const key = yield* nextKey(candidate, tried);
      if (!key) break;
      tried.add(key);
      const response = yield* send(candidate, key);
      // An unreachable upstream will not answer on another key either.
      if (!response) continue routes;
      void upstream?.body?.cancel().catch(() => { });
      upstream = response;
      route = candidate;
      if (candidate === "byok" && (response.status === 401 || response.status === 403)) yield* invalidateByok;
      if (!FAILOVER_STATUSES.includes(response.status)) break routes;
    }
  }

  if (!upstream) {
    if (signal.aborted) {
      yield* settleNow("aborted");
      return HttpServerResponse.empty({ status: 499, headers: { "x-router-request-id": requestId } });
    }
    yield* settleNow("error");
    return yield* byokUnreadable && attempts.length === 1
      ? chatError(502, "byok_unreadable", "Unable to use your personal Lumen key. Re-add it from Connections.", requestId)
      : chatError(502, "upstream_unreachable", "Unable to reach the upstream.", requestId);
  }

  const served = upstream;
  const respond = (body: BodyInit | null) => {
    const headers = new Headers(served.headers);
    headers.set("x-router-session", sessionId);
    headers.set("x-router-request-id", requestId);
    return HttpServerResponse.fromWeb(new Response(body, { status: served.status, headers }));
  };

  if (!served.ok || !served.body) {
    const errorText = yield* Effect.promise(() => served.text().catch(() => ""));
    console.error({ event: "upstream_http_error", ...logContext, route, upstreamStatus: served.status, ...upstreamErrorFields(jsonField(errorText, "error")) });
    yield* settleNow("error");
    return respond(errorText || null);
  }

  const isEventStream = (served.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!chat.stream || !isEventStream) {
    const responseText = yield* Effect.tryPromise(() => served.text()).pipe(Effect.orElseSucceed(() => null));
    if (responseText === null) {
      console.error({ event: "upstream_body_read_error", ...logContext, route, upstreamStatus: served.status, clientAborted: signal.aborted });
      yield* settleNow(signal.aborted ? "aborted" : "error");
      return yield* chatError(502, "upstream_unreachable", "Unable to read the upstream response.", requestId);
    }
    const error = jsonField(responseText, "error");
    if (error) console.error({ event: "upstream_body_error", ...logContext, route, upstreamStatus: served.status, ...upstreamErrorFields(error) });
    yield* settleNow(error ? "error" : "ok", parseOpenAiUsage(jsonField(responseText, "usage")));
    return respond(responseText);
  }

  // Streams are proxied as web streams. Usage is captured on the way through
  // and settled before the terminal events reach the client.
  const capture = usageCaptureTransform({
    clientWantsUsage: chat.clientWantsUsage,
    onError: (error) => console.error({ event: "upstream_stream_error", ...logContext, route, upstreamStatus: served.status, ...upstreamErrorFields(error) }),
    onFinish: finish,
  });
  const output = new TransformStream<Uint8Array, Uint8Array>();
  // Errors and client cancellation do not always reach the transformer's
  // flush, so the pump is observed too.
  const pump = served.body.pipeThrough(capture.transform).pipeTo(output.writable).catch(async (error: unknown) => {
    console.error({ event: "upstream_stream_interrupted", ...logContext, route, upstreamStatus: served.status, clientAborted: signal.aborted, errorName: errorName(error) });
    await capture.finish("aborted");
  });
  execution.waitUntil(pump);
  return respond(output.readable);
});

function limitReached(reason: DenyReason, snapshot: UsageSnapshot, requestId: string) {
  const window = reason === "weekly_cap" ? snapshot.weekly : snapshot.fiveHour;
  const label = reason === "weekly_cap" ? "Weekly" : "Five-hour";
  const publicWindow = (value: typeof window) => ({
    usedPercent: value.limitMicro > 0 ? value.usedMicro / value.limitMicro * 100 : 100,
    resetsInMs: value.resetsInMs,
  });
  return HttpServerResponse.jsonUnsafe({
    error: {
      message: `${label} usage allowance reached. It resets in ${formatDuration(window.resetsInMs)}.`,
      type: "rate_limit_error",
      code: "usage_limit_reached",
      param: null,
    },
    usage: { fiveHour: publicWindow(snapshot.fiveHour), weekly: publicWindow(snapshot.weekly) },
  }, {
    status: 429,
    headers: { "retry-after": String(Math.max(1, Math.ceil(window.resetsInMs / 1000))), "x-router-request-id": requestId },
  });
}

function jsonField(text: string, field: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? diagnosticIdentifier(error.name) : null;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 48) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const inferenceRoutes = HttpRouter.add("POST", "/inference/v1/chat/completions", handleChat).pipe(
  Layer.provide(inferenceKeyAuth),
);
