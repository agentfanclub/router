import { Show, createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { AfcUsage } from "./rpc";
import { formatCompact, formatDetails, usageSeverity, type PublicUsage } from "./usage";

type RpcFailure = {
  type: string;
  message?: string;
};

function failure(cause: unknown): RpcFailure | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const record = cause as Record<string, unknown>;
  return typeof record.type === "string"
    ? { type: record.type, ...(typeof record.message === "string" ? { message: record.message } : {}) }
    : undefined;
}

export default Plugin.define({
  id: "agentfanclub.tui",
  async setup(context) {
    const [usage, setUsage] = createSignal<PublicUsage | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    let inFlight: Promise<void> | undefined;
    let disposed = false;

    async function refresh(): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const result = await context.client.rpc(AfcUsage).get({}) as PublicUsage;
          if (disposed) return;
          setUsage(result);
          setError(null);
        } catch (cause) {
          if (disposed) return;
          const rpcError = failure(cause);
          setUsage(null);
          setError(rpcError?.type === "not_connected"
            ? "Connect Agent Fan Club with /connect before checking usage."
            : rpcError?.message ?? "Couldn't load Agent Fan Club usage. Try again.");
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    }

    await refresh();

    function severityColor(current: PublicUsage) {
      const severity = usageSeverity(current);
      if (severity === "critical") return context.theme.text.feedback.error.base;
      if (severity === "warning") return context.theme.text.feedback.warning.base;
      return context.theme.text.muted;
    }

    const status = () => (
      <Show when={usage()} keyed>
        {(current: PublicUsage) => (
          <text fg={severityColor(current)}>{formatCompact(current)}</text>
        )}
      </Show>
    );

    const stops = [
      context.ui.slot({ append: "prompt.footer.status", render: status }),
      context.ui.slot({ append: "home.footer.status", render: status }),
      context.data.on("credential.updated", () => { void refresh(); }),
      context.data.on("credential.switched", () => { void refresh(); }),
      context.data.on("integration.updated", () => { void refresh(); }),
      context.data.on("session.execution.succeeded", () => { void refresh(); }),
      context.data.on("session.usage.updated", () => { void refresh(); }),
    ];

    const timer = setInterval(() => { void refresh(); }, 5 * 60_000);

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "agentfanclub.usage",
        title: "Agent Fan Club usage",
        group: "Agent Fan Club",
        palette: true,
        slash: { name: "afc" },
        run: async () => {
          await refresh();
          const current = usage();
          if (!current) {
            context.ui.toast.show({
              title: "Agent Fan Club",
              message: error() ?? "Couldn't load Agent Fan Club usage. Try again.",
              variant: "warning",
            });
            return;
          }
          context.ui.dialog.alert({
            title: "Agent Fan Club usage",
            message: formatDetails(current).replace("Agent Fan Club usage\n\n", ""),
          });
        },
      }],
    }));

    return () => {
      disposed = true;
      clearInterval(timer);
      for (const stop of stops) stop();
    };
  },
});
