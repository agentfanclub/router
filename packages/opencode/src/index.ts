import { setTimeout } from "node:timers/promises";
import { Credential, Integration, Model, Plugin, Provider } from "@opencode/plugin";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const providerID = Provider.ID.make("agentfanclub");
const integrationID = Integration.ID.make("agentfanclub");
const methodID = Integration.MethodID.make("browser");
const tracer = trace.getTracer("@agentfanclub/opencode");

type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationURL: string;
  expiresAt: string;
  interval: number;
};

type DeviceToken = { token: string } | { error: string };

type ApiModel = {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  limit: { context: number; output: number };
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  modalities: { input: ("text" | "image")[]; output: string[] };
};

export default Plugin.define({
  id: "agentfanclub",
  async setup(ctx) {
    const apiUrl = new URL(ctx.options.apiUrl ?? "https://api.router.agentfan.club");
    const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname);
    const name = isLocalhost ? "Agent Fan Club (dev)" : "Agent Fan Club";

    if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && isLocalhost)) {
      throw new Error("Agent Fan Club apiUrl must use HTTPS, or HTTP on localhost.");
    }

    if (apiUrl.username || apiUrl.password || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
      throw new Error("Agent Fan Club apiUrl must be an origin without a path or credentials.");
    }

    const baseUrl = `${apiUrl.origin}/inference/v1`;
    const lifecycle = new AbortController();
    let models: Model.Info[] = [];
    let discoveryError: Error | undefined;

    async function activeToken() {
      const connection = await ctx.integration.connection.active(integrationID);
      if (!connection) return;
      const credential = await ctx.integration.connection.resolve(connection);
      if (credential?.type !== "oauth" || credential.metadata?.apiUrl !== apiUrl.origin) return;
      return credential.access;
    }

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name,
          integrationID,
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: baseUrl },
        },
        models,
      });
    });

    await ctx.session.hook(
      "model.request",
      async (event) => {
        const token = await activeToken();
        if (!token) throw new Error("Connect Agent Fan Club with /connect before sending requests.");
        if (discoveryError) throw discoveryError;
        event.baseURL = baseUrl;
        event.headers.authorization = `Bearer ${token}`;
      },
      { providerID },
    );

    await ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = name;
      });

      editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: `Sign in to ${name}` },
        label: () => `${name} OpenCode`,
        async authorize() {
          const response = await fetch(`${apiUrl.origin}/api/device/code`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: "opencode" }),
            redirect: "error",
            signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(15_000)]),
          });

          if (!response.ok) throw new Error("Couldn't start Agent Fan Club sign-in. Try again.");

          const attempt = await response.json() as DeviceAuthorization;

          const expiresAt = Date.parse(attempt.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000) {
            throw new Error("Agent Fan Club returned an invalid connection expiry.");
          }

          const { deviceCode, userCode, verificationURL, interval } = attempt;
          const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))]);
          const callback = (async () => {
            let pollInterval = interval;
            while (!signal.aborted) {
              await setTimeout(pollInterval * 1000, undefined, { signal });
              const response = await fetch(`${apiUrl.origin}/api/device/token`, {
                method: "POST",
                redirect: "error",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deviceCode }),
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
              });

              const result = await response.json() as DeviceToken;
              if (response.ok && "token" in result) {
                return Credential.OAuth.make({
                  type: "oauth",
                  methodID,
                  access: result.token,
                  refresh: "",
                  expires: 0,
                  metadata: { apiUrl: apiUrl.origin },
                });
              }

              if ("error" in result) {
                switch (result.error) {
                  case "authorization_pending":
                    continue;
                  case "slow_down":
                    pollInterval += 5;
                    continue;
                  case "access_denied":
                    throw new Error("Agent Fan Club connection was declined.");
                }
              }
              throw new Error("Agent Fan Club connection expired or failed. Start again with /connect.");
            }
            throw new Error("Agent Fan Club sign-in was cancelled or expired.");
          })();

          return {
            url: verificationURL,
            instructions: `Confirm code ${userCode} on Agent Fan Club. Only approve the request you started here.`,
            mode: "auto",
            expiresAt,
            callback,
          };
        },
      });
    });

    async function refreshModels() {
      const span = tracer.startSpan("agentfanclub.models.refresh");
      models = [];
      discoveryError = undefined;

      try {
        const token = await activeToken();
        if (token) {
          const response = await fetch(`${apiUrl.origin}/api/models`, {
            headers: { authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(15_000)]),
          });

          if (!response.ok) throw new Error("Couldn't load Agent Fan Club models. Check your connection and API key, then reconnect.");
          const result = await response.json() as Record<string, ApiModel>;

          models = Object.values(result).map((model) => ({
            ...Model.Info.default(providerID, Model.ID.make(model.id)),
            name: model.name,
            capabilities: {
              tools: model.tool_call,
              input: model.modalities.input,
              output: model.modalities.output,
            },
            limit: model.limit,
            cost: [{
              input: model.cost.input as Model.Cost["input"],
              output: model.cost.output as Model.Cost["output"],
              cache: {
                read: model.cost.cache_read as Model.Cost["cache"]["read"],
                write: model.cost.cache_write as Model.Cost["cache"]["write"],
              },
            }],
          }));
        }
      } catch {
        // Keep sign-in available when a stored key is revoked or the server is down.
        discoveryError = new Error("Couldn't load Agent Fan Club models. Check the API endpoint and reconnect with /connect.");
        span.setStatus({ code: SpanStatusCode.ERROR, message: discoveryError.message });
      } finally {
        span.end();
      }

      await ctx.provider.reload();
    }

    await refreshModels();

    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
        if (
          event.type === "credential.updated" ||
          (event.type === "credential.switched" && event.data.integrationID === integrationID)
        ) {
          await refreshModels();
        }
      }
    })().catch(() => {
      if (!lifecycle.signal.aborted) {
        discoveryError = new Error("Agent Fan Club connection updates stopped. Reload OpenCode to reconnect.");
      }
    });

    return async () => {
      lifecycle.abort();
      await events;
    };
  },
});
