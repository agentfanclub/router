import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import models from "../data/models.json";
import { byokKey } from "../db/schema";
import { type AdmitResult, type UpstreamRoute } from "../do/user-usage";
import { ApiKeyIdentity, inferenceKeyAuth } from "../middleware/api-key-auth";
import { decryptSecret } from "../util/secret-box";
import {
  computeCostMicro,
  deriveSessionId,
  parseOpenAiUsage,
  type ParsedUsage,
  type RoutePrice,
} from "../util/usage";
import { usageCaptureTransform } from "../util/sse-usage";
import { diagnosticIdentifier, upstreamErrorFields } from "../util/upstream-diagnostics";
import { WorkerEnv, WorkerExecution } from "../worker-env";

const LUMEN_CHAT_URL = "https://lumen.ncsa.illinois.edu/v1/chat/completions";

type CatalogModel = (typeof models)[keyof typeof models];
const catalog = models as unknown as Record<string, CatalogModel>;

interface ChatBody {
  model: string;
  messages: unknown[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage?: boolean } | null;
}

function parseChatBody(raw: string): ChatBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.model !== "string" || !Array.isArray(record.messages)) return null;
  return {
    model: record.model,
    messages: record.messages,
    stream: record.stream === true,
    max_tokens: typeof record.max_tokens === "number" ? record.max_tokens : undefined,
    max_completion_tokens: typeof record.max_completion_tokens === "number" ? record.max_completion_tokens : undefined,
    stream_options:
      record.stream_options && typeof record.stream_options === "object"
        ? record.stream_options as ChatBody["stream_options"]
        : null,
  };
}

function modelPrice(entry: CatalogModel): RoutePrice {
  return { input: entry.cost.input, output: entry.cost.output, cacheRead: entry.cost.cache_read };
}

function chatError(message: string, code: string, status: 400 | 404 | 429 | 502 | 503, requestId?: string) {
  return HttpServerResponse.jsonUnsafe({
    error: { message, type: status === 429 ? "rate_limit_error" : "server_error", code, param: null },
  }, { status, headers: requestId ? { "x-router-request-id": requestId } : undefined });
}

const handleRequest = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const execution = yield* WorkerExecution;
  const identity = yield* ApiKeyIdentity;
  const request = yield* HttpServerRequest.HttpServerRequest;

  const webRequest = yield* HttpServerRequest.toWeb(request);
  const rawBody = yield* Effect.tryPromise(() => webRequest.text()).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (rawBody === null) {
    return chatError("Unable to read the request body.", "invalid_request", 400);
  }

  const body = parseChatBody(rawBody);
  if (!body) {
    return chatError("The request body must be a JSON chat completion with model and messages.", "invalid_request", 400);
  }

  const entry = catalog[body.model];
  if (!entry) {
    return chatError(
      `Unknown model '${body.model}'. Available models: ${Object.keys(catalog).join(", ")}.`,
      "model_not_found",
      404,
    );
  }

  // Derive the grouping and cache-affinity tag on the server, independent
  // of client-supplied session headers.
  const sessionId = deriveSessionId(body.messages);

  const price = modelPrice(entry);
  const requestedMaxOutput = body.max_tokens ?? body.max_completion_tokens;
  const maxOutputTokens = requestedMaxOutput && requestedMaxOutput > 0
    ? Math.min(requestedMaxOutput, entry.limit.output)
    : entry.limit.output;
  const inputEstimateTokens = Math.ceil(rawBody.length / 4);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const logContext = { requestId, model: body.model, stream: body.stream === true };

  const stub = env.USER_USAGE.get(env.USER_USAGE.idFromName(identity.userId));
  // A personal Lumen key is a fallback upstream: it can serve when the club
  // allowance is exhausted or the shared Lumen account cannot. The club key
  // being unset simply marks the club upstream unavailable.
  const byokAvailable = identity.byok !== null && Boolean(env.BYOK_ENCRYPTION_KEY);
  const admit = yield* Effect.tryPromise(() => stub.fetch("https://usage/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      sessionId,
      userId: identity.userId,
      apiKeyId: identity.keyId,
      model: body.model,
      createdAt: startedAt,
      inputEstimateTokens,
      maxOutputTokens,
      limits: identity.limits,
      upstreams: {
        clubLumen: env.LUMEN_API_KEY ? "ok" : "dry",
        byok: byokAvailable,
        opencodeGo: false,
      },
      prices: { clubLumen: price },
    }),
  })).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (!admit || !admit.ok) {
    console.error({ event: "inference_admission_error", ...logContext, coordinatorStatus: admit?.status ?? null });
    // Fail closed: if the usage coordinator is unreachable, serving anyway
    // would bypass every limit.
    return chatError("Unable to check usage limits right now. Try again.", "usage_unavailable", 503, requestId);
  }
  const decision: AdmitResult = yield* Effect.promise(() => admit.json<AdmitResult>());

  // The upstream that actually serves this request. It starts as the route
  // the coordinator chose and can flip to the user's personal key mid-request
  // on failover, so settle and logging read it at completion time.
  let route: UpstreamRoute = decision.decision === "admit" ? decision.route : "club-lumen";

  const db = drizzle(env.DB);
  if (decision.decision === "deny") {
    console.info({ event: "inference_denied", ...logContext, reason: decision.reason });
    if (decision.reason === "no_upstream") {
      return chatError("No upstream is currently available to serve this request. Try again soon.", "no_upstream", 503, requestId);
    }
    const window = decision.reason === "weekly_cap" ? decision.snapshot.weekly : decision.snapshot.fiveHour;
    const label = decision.reason === "weekly_cap" ? "Weekly" : "Five-hour";
    const message = `${label} usage allowance reached. It resets in ${formatDuration(window.resetsInMs)}.`;
    const publicWindow = (value: typeof window) => ({
      usedPercent: value.limitMicro > 0 ? value.usedMicro / value.limitMicro * 100 : 100,
      resetsInMs: value.resetsInMs,
    });
    return HttpServerResponse.jsonUnsafe({
      error: { message, type: "rate_limit_error", code: "usage_limit_reached", param: null },
      usage: { fiveHour: publicWindow(decision.snapshot.fiveHour), weekly: publicWindow(decision.snapshot.weekly) },
    }, {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil(window.resetsInMs / 1000))), "x-router-request-id": requestId },
    });
  }

  // Reservations bound in-flight usage. Only reported token usage becomes spend.
  // An interrupted response without usage has an unknown cost, recorded as zero.
  const finalize = async (args: { status: "ok" | "error" | "aborted"; usage: ParsedUsage | null; durationMs: number }) => {
    console.info({ event: "inference_finished", ...logContext, route, status: args.status, durationMs: args.durationMs });
    const costMicro = args.usage !== null
      ? computeCostMicro(args.usage, price)
      : 0;
    const settlement = async () => {
      const response = await stub.fetch("https://usage/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId, userId: identity.userId, route, costMicro, limits: identity.limits,
          usage: args.usage,
          estimated: args.usage === null && args.status !== "error",
          status: args.status,
          durationMs: args.durationMs,
        }),
      });
      if (!response.ok) throw new Error(`Usage settlement failed: ${response.status}`);
    };
    // A terminal stream event can cause the client to close its connection.
    // Keep the settlement alive independently of that response's lifetime.
    const pending = settlement().catch(() => settlement()).catch((error: unknown) => {
      console.error({ event: "inference_settlement_error", ...logContext, route });
      throw error;
    });
    execution.waitUntil(pending);
    await pending;
  };

  // Ask the upstream for usage data on streams even when the client did not,
  // so real token counts back the cost accounting. The injected final usage
  // chunk is hidden from clients that did not request it.
  const clientWantsUsage = body.stream_options?.include_usage === true;
  const upstreamBodyText = body.stream && !clientWantsUsage
    ? JSON.stringify({ ...JSON.parse(rawBody), stream_options: { include_usage: true } })
    : rawBody;

  let attempt = 0;
  const sendUpstream = async (credential: string, attemptRoute: UpstreamRoute) => {
    const attemptNumber = ++attempt;
    const attemptStartedAt = Date.now();
    const attemptContext = { ...logContext, route: attemptRoute, attempt: attemptNumber };
    console.info({ event: "upstream_started", ...attemptContext });
    try {
      const response = await fetch(LUMEN_CHAT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": webRequest.headers.get("content-type") ?? "application/json",
          accept: request.headers.accept ?? "application/json",
          "x-opencode-session": sessionId,
        },
        body: upstreamBodyText,
        signal: webRequest.signal,
        redirect: "manual",
      });
      console.info({
        event: "upstream_response", ...attemptContext,
        upstreamStatus: response.status,
        headersMs: Date.now() - attemptStartedAt,
        upstreamRay: diagnosticIdentifier(response.headers.get("cf-ray")),
        upstreamRequestId: diagnosticIdentifier(response.headers.get("x-request-id")),
      });
      return response;
    } catch (error) {
      console.error({
        event: "upstream_fetch_error", ...attemptContext,
        elapsedMs: Date.now() - attemptStartedAt,
        clientAborted: webRequest.signal.aborted,
        errorName: error instanceof Error ? diagnosticIdentifier(error.name) : null,
      });
      throw error;
    }
  };

  const personalCredential = () => identity.byok && env.BYOK_ENCRYPTION_KEY
    ? decryptSecret(identity.byok.ciphertext, env.BYOK_ENCRYPTION_KEY)
    : Promise.resolve(null);

  // Choose the starting credential from the admitted route. The coordinator
  // never routes club-lumen without a club key or byok without a stored key.
  let credential: string | null = route === "byok" ? null : env.LUMEN_API_KEY ?? null;
  if (route === "byok") {
    credential = yield* Effect.promise(personalCredential);
    if (!credential) {
      yield* Effect.promise(() => finalize({ status: "error", usage: null, durationMs: Date.now() - startedAt }));
      return chatError("Unable to use your personal Lumen key. Re-add it from Connections.", "byok_unreadable", 502, requestId);
    }
  } else if (!credential) {
    yield* Effect.promise(() => finalize({ status: "error", usage: null, durationMs: Date.now() - startedAt }));
    return chatError("No upstream is currently available to serve this request.", "no_upstream", 503, requestId);
  }

  let upstream = yield* Effect.tryPromise(() => sendUpstream(credential!, route)).pipe(
    Effect.orElseSucceed(() => null),
  );

  if (!upstream) {
    const aborted = webRequest.signal.aborted;
    yield* Effect.promise(() => finalize({ status: aborted ? "aborted" : "error", usage: null, durationMs: Date.now() - startedAt }));
    if (aborted) {
      return HttpServerResponse.fromWeb(new Response(null, { status: 499, headers: { "x-router-request-id": requestId } }));
    }
    return chatError("Unable to reach Lumen.", "upstream_unreachable", 502, requestId);
  }

  // Seamless failover: the club account cannot serve (auth, payment, or
  // quota) while the user has a personal key — retry there immediately.
  // The client never sees the first failure, and the club reservation is
  // released without charge when the request settles on the personal key.
  if (route === "club-lumen" && byokAvailable && [401, 402, 429].includes(upstream.status)) {
    const secret = yield* Effect.promise(personalCredential);
    if (secret) {
      const first = upstream;
      const retry = yield* Effect.tryPromise(() => sendUpstream(secret, "byok")).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (retry) {
        void first.body?.cancel().catch(() => {});
        route = "byok";
        upstream = retry;
      }
    }
  }

  // A personal key Lumen refuses is marked invalid so later requests move on
  // to the user's next key or the club upstream instead of retrying it.
  if (route === "byok" && identity.byok && (upstream.status === 401 || upstream.status === 403)) {
    yield* Effect.promise(() => db
      .update(byokKey)
      .set({ status: "invalid" })
      .where(eq(byokKey.id, identity.byok!.id))
      .catch((error) => console.error("byok invalidation failed", requestId, error)),
    );
  }

  if (!upstream.ok || !upstream.body) {
    const errorText = yield* Effect.promise(() => upstream.text().catch(() => ""));
    let error: unknown;
    try { error = (JSON.parse(errorText) as { error?: unknown } | null)?.error; } catch {}
    console.error({ event: "upstream_http_error", ...logContext, route, upstreamStatus: upstream.status, ...upstreamErrorFields(error) });
    yield* Effect.promise(() => finalize({ status: "error", usage: null, durationMs: Date.now() - startedAt }));
    return HttpServerResponse.fromWeb(new Response(errorText || null, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers, sessionId, requestId),
    }));
  }

  // Buffered responses: read the body, pull the usage object, settle, forward.
  const respondBuffered = (text: string) => Effect.gen(function* () {
    let usage: ParsedUsage | null = null;
    try {
      usage = parseOpenAiUsage((JSON.parse(text) as { usage?: unknown }).usage);
    } catch {
      usage = null;
    }
    let hasError = false;
    try {
      const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
      hasError = Boolean(error);
      if (hasError) console.error({ event: "upstream_body_error", ...logContext, route, upstreamStatus: upstream.status, ...upstreamErrorFields(error) });
    } catch {}
    yield* Effect.promise(() => finalize({ status: hasError ? "error" : "ok", usage, durationMs: Date.now() - startedAt }));
    return HttpServerResponse.fromWeb(new Response(text, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers, sessionId, requestId),
    }));
  });

  const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!body.stream || !isEventStream) {
    const text = yield* Effect.tryPromise(() => upstream.text()).pipe(Effect.orElseSucceed(() => null));
    if (text === null) {
      console.error({ event: "upstream_body_read_error", ...logContext, route, upstreamStatus: upstream.status, clientAborted: webRequest.signal.aborted });
      yield* Effect.promise(() => finalize({ status: webRequest.signal.aborted ? "aborted" : "error", usage: null, durationMs: Date.now() - startedAt }));
      return chatError("Unable to read the upstream response.", "upstream_unreachable", 502, requestId);
    }
    return yield* respondBuffered(text);
  }

  const capture = usageCaptureTransform({
    clientWantsUsage,
    onError: (error) => console.error({ event: "upstream_stream_error", ...logContext, route, upstreamStatus: upstream.status, ...upstreamErrorFields(error) }),
    onFinish: (status, usage) => finalize({ status, usage, durationMs: Date.now() - startedAt }),
  });
  const output = new TransformStream<Uint8Array, Uint8Array>();
  // Observe the pump as well as normal stream completion. Errors and client
  // cancellation do not necessarily invoke a transformer's flush callback.
  const pump = upstream.body.pipeThrough(capture.transform).pipeTo(output.writable)
    .catch(async (error: unknown) => {
      console.error({ event: "upstream_stream_interrupted", ...logContext, route, upstreamStatus: upstream.status, clientAborted: webRequest.signal.aborted, errorName: error instanceof Error ? diagnosticIdentifier(error.name) : null });
      await capture.finish("aborted");
    });
  execution.waitUntil(pump);
  const piped = output.readable;

  return HttpServerResponse.fromWeb(new Response(piped, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers, sessionId, requestId),
  }));
});

function responseHeaders(upstream: Headers, sessionId: string, requestId: string): Headers {
  const headers = new Headers(upstream);
  headers.set("x-router-session", sessionId);
  headers.set("x-router-request-id", requestId);
  return headers;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 48) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const inferenceRoutes = HttpRouter.add("POST", "/inference/v1/chat/completions", handleRequest).pipe(
  Layer.provide(inferenceKeyAuth),
);
