import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { byokKey } from "../db/schema";
import type { AdmitResult, UsageSnapshot } from "../do/user-usage";
import type { ApiEnv } from "../env";
import { ApiKeyIdentity, inferenceKeyAuth, type ApiKeyIdentityValue } from "../middleware/api-key-auth";
import { catalog, upstreams, type CatalogModel, type UpstreamRoute } from "../upstreams";
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
import { WorkerEnv, WorkerExecution } from "../worker-env";

type Status = "ok" | "error" | "aborted";

// Upstream statuses meaning "this account cannot serve right now". The next
// route is tried before the client sees anything.
const FAILOVER_STATUSES = [401, 402, 429];

interface ChatRequest {
  // The client's body, forwarded with only the changes the router needs.
  raw: Record<string, unknown>;
  model: string;
  messages: unknown[];
  stream: boolean;
  maxTokens: number | undefined;
  clientWantsUsage: boolean;
}

interface Context {
  env: ApiEnv;
  execution: ExecutionContext;
  identity: ApiKeyIdentityValue;
  request: Request;
}

function parseChatRequest(text: string): ChatRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.model !== "string" || !Array.isArray(body.messages)) return null;
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  const streamOptions = body.stream_options as { include_usage?: unknown } | null | undefined;
  return {
    raw: body,
    model: body.model,
    messages: body.messages,
    stream: body.stream === true,
    maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : undefined,
    clientWantsUsage: streamOptions?.include_usage === true,
  };
}

function chatError(message: string, code: string, status: number, requestId?: string): Response {
  return Response.json({
    error: { message, type: status === 429 ? "rate_limit_error" : "server_error", code, param: null },
  }, { status, headers: requestId ? { "x-router-request-id": requestId } : undefined });
}

function modelPrice(model: CatalogModel): RoutePrice {
  return { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cache_read };
}

// Club routes the model is served by and whose credential is configured, in
// priority order, followed by the user's own key when it can serve the model.
function availableRoutes({ env, identity }: Context, model: CatalogModel): UpstreamRoute[] {
  const routes: UpstreamRoute[] = model.upstreams.filter((id) => upstreams[id].credential(env));
  if (identity.byok && env.BYOK_ENCRYPTION_KEY && model.upstreams.includes("lumen")) routes.push("byok");
  return routes;
}

async function handleChat(ctx: Context): Promise<Response> {
  const { env, execution, identity, request } = ctx;

  const text = await request.text().catch(() => null);
  if (text === null) return chatError("Unable to read the request body.", "invalid_request", 400);
  const chat = parseChatRequest(text);
  if (!chat) {
    return chatError("The request body must be a JSON chat completion with model and messages.", "invalid_request", 400);
  }
  const model = catalog[chat.model];
  if (!model) {
    return chatError(
      `Unknown model '${chat.model}'. Available models: ${Object.keys(catalog).join(", ")}.`,
      "model_not_found",
      404,
    );
  }

  // Derived on the server so grouping and cache affinity do not depend on
  // client-supplied session headers.
  const sessionId = deriveSessionId(chat.messages);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const logContext = { requestId, model: chat.model, stream: chat.stream };
  const price = modelPrice(model);

  const routes = availableRoutes(ctx, model);
  if (routes.length === 0) {
    console.error({ event: "inference_no_upstream", ...logContext });
    return chatError("No upstream is currently available to serve this request.", "no_upstream", 503, requestId);
  }

  const usage = () => env.USER_USAGE.getByName(identity.userId);
  let decision: AdmitResult;
  try {
    decision = await usage().admit({
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
    });
  } catch (error) {
    console.error({ event: "inference_admission_error", ...logContext, errorName: errorName(error) });
    // Fail closed: serving without the coordinator would bypass every limit.
    return chatError("Unable to check usage limits right now. Try again.", "usage_unavailable", 503, requestId);
  }

  if (decision.decision === "deny") {
    console.info({ event: "inference_denied", ...logContext, reason: decision.reason });
    return limitReached(decision.reason, decision.snapshot, requestId);
  }

  // The route that served the request. Failover can change it, so settlement
  // reads it at completion time.
  let route = decision.route;

  // Only reported usage becomes spend. An interrupted response without usage
  // has an unknown cost and is recorded as zero.
  const finish = async (status: Status, parsed: ParsedUsage | null) => {
    const durationMs = Date.now() - startedAt;
    console.info({ event: "inference_finished", ...logContext, route, status, durationMs });
    const settle = () => usage().settle({
      requestId, route, status, durationMs,
      usage: parsed,
      costMicro: parsed ? computeCostMicro(parsed, price) : 0,
      limits: identity.limits,
    });
    // Settlement must outlive the client connection, which can close as soon
    // as it sees the terminal stream event.
    const pending = settle().catch(settle).then(
      () => undefined,
      (error: unknown) => console.error({ event: "inference_settlement_error", ...logContext, route, errorName: errorName(error) }),
    );
    execution.waitUntil(pending);
    await pending;
  };

  const responseHeaders = (upstream: Headers) => {
    const headers = new Headers(upstream);
    headers.set("x-router-session", sessionId);
    headers.set("x-router-request-id", requestId);
    return headers;
  };

  const credential = async (candidate: UpstreamRoute) => {
    if (candidate !== "byok") return upstreams[candidate].credential(env) ?? null;
    return decryptSecret(identity.byok!.ciphertext, env.BYOK_ENCRYPTION_KEY!).catch(() => null);
  };

  let attempt = 0;
  const send = async (candidate: UpstreamRoute, key: string) => {
    const upstream = upstreams[candidate === "byok" ? "lumen" : candidate];
    const body = { ...chat.raw };
    // Streams always ask for usage so real token counts back the accounting.
    // The extra usage chunk is hidden from clients that did not ask for it.
    if (chat.stream) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    upstream.prepareBody?.(body);

    const attemptContext = { ...logContext, route: candidate, attempt: ++attempt };
    const attemptStartedAt = Date.now();
    console.info({ event: "upstream_started", ...attemptContext });
    try {
      const response = await fetch(upstream.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: request.headers.get("accept") ?? "application/json",
          "x-opencode-session": sessionId,
        },
        body: JSON.stringify(body),
        signal: request.signal,
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
        clientAborted: request.signal.aborted,
        errorName: errorName(error),
      });
      return null;
    }
  };

  // Start on the admitted route and fail over through the rest in priority
  // order. A request admitted to the user's own key is over the club
  // allowance and never falls back onto a club route.
  const attempts = decision.route === "byok"
    ? ["byok" as const]
    : [decision.route, ...routes.filter((candidate) => candidate !== decision.route)];
  let upstream: Response | null = null;
  let byokUnreadable = false;
  for (const candidate of attempts) {
    if (request.signal.aborted) break;
    const key = await credential(candidate);
    if (!key) {
      byokUnreadable ||= candidate === "byok";
      continue;
    }
    const response = await send(candidate, key);
    if (!response) continue;
    void upstream?.body?.cancel().catch(() => { });
    upstream = response;
    route = candidate;
    // A personal key Lumen refuses is marked invalid so later requests stop
    // trying it.
    if (candidate === "byok" && (response.status === 401 || response.status === 403)) {
      await drizzle(env.DB).update(byokKey).set({ status: "invalid" }).where(eq(byokKey.id, identity.byok!.id))
        .catch((error) => console.error({ event: "byok_invalidation_error", ...logContext, errorName: errorName(error) }));
    }
    if (!FAILOVER_STATUSES.includes(response.status)) break;
  }

  if (!upstream) {
    if (request.signal.aborted) {
      await finish("aborted", null);
      return new Response(null, { status: 499, headers: { "x-router-request-id": requestId } });
    }
    await finish("error", null);
    if (byokUnreadable && attempts.length === 1) {
      return chatError("Unable to use your personal Lumen key. Re-add it from Connections.", "byok_unreadable", 502, requestId);
    }
    return chatError("Unable to reach the upstream.", "upstream_unreachable", 502, requestId);
  }

  const served = upstream;
  if (!served.ok || !served.body) {
    const errorText = await served.text().catch(() => "");
    console.error({ event: "upstream_http_error", ...logContext, route, upstreamStatus: served.status, ...upstreamErrorFields(jsonField(errorText, "error")) });
    await finish("error", null);
    return new Response(errorText || null, { status: served.status, headers: responseHeaders(served.headers) });
  }

  const isEventStream = (served.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!chat.stream || !isEventStream) {
    const responseText = await served.text().catch(() => null);
    if (responseText === null) {
      console.error({ event: "upstream_body_read_error", ...logContext, route, upstreamStatus: served.status, clientAborted: request.signal.aborted });
      await finish(request.signal.aborted ? "aborted" : "error", null);
      return chatError("Unable to read the upstream response.", "upstream_unreachable", 502, requestId);
    }
    const error = jsonField(responseText, "error");
    if (error) console.error({ event: "upstream_body_error", ...logContext, route, upstreamStatus: served.status, ...upstreamErrorFields(error) });
    await finish(error ? "error" : "ok", parseOpenAiUsage(jsonField(responseText, "usage")));
    return new Response(responseText, { status: served.status, headers: responseHeaders(served.headers) });
  }

  const capture = usageCaptureTransform({
    clientWantsUsage: chat.clientWantsUsage,
    onError: (error) => console.error({ event: "upstream_stream_error", ...logContext, route, upstreamStatus: served.status, ...upstreamErrorFields(error) }),
    onFinish: finish,
  });
  const output = new TransformStream<Uint8Array, Uint8Array>();
  // Errors and client cancellation do not always reach the transformer's
  // flush, so the pump is observed too.
  const pump = served.body.pipeThrough(capture.transform).pipeTo(output.writable).catch(async (error: unknown) => {
    console.error({ event: "upstream_stream_interrupted", ...logContext, route, upstreamStatus: served.status, clientAborted: request.signal.aborted, errorName: errorName(error) });
    await capture.finish("aborted");
  });
  execution.waitUntil(pump);
  return new Response(output.readable, { status: served.status, headers: responseHeaders(served.headers) });
}

function limitReached(reason: "five_hour_cap" | "weekly_cap", snapshot: UsageSnapshot, requestId: string): Response {
  const window = reason === "weekly_cap" ? snapshot.weekly : snapshot.fiveHour;
  const label = reason === "weekly_cap" ? "Weekly" : "Five-hour";
  const publicWindow = (value: typeof window) => ({
    usedPercent: value.limitMicro > 0 ? value.usedMicro / value.limitMicro * 100 : 100,
    resetsInMs: value.resetsInMs,
  });
  return Response.json({
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

const handleRequest = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const execution = yield* WorkerExecution;
  const identity = yield* ApiKeyIdentity;
  const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
  const response = yield* Effect.promise(() => handleChat({ env, execution, identity, request }));
  return HttpServerResponse.fromWeb(response);
});

export const inferenceRoutes = HttpRouter.add("POST", "/inference/v1/chat/completions", handleRequest).pipe(
  Layer.provide(inferenceKeyAuth),
);
