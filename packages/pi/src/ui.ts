import { formatCompact, formatDetails, usageSeverity, type PublicUsage } from "./usage";

export const PROVIDER_ID = "agentfanclub";
const STATUS_KEY = "agentfanclub-usage";
const REFRESH_MS = 5 * 60_000;

type UiTheme = {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
};

interface Pane {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface UsageContext {
  mode: string;
  hasUI: boolean;
  model?: { provider: string };
  modelRegistry: {
    getApiKeyForProvider(provider: string): Promise<string | undefined>;
  };
  ui: {
    theme?: UiTheme;
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom<T>(
      factory: (tui: unknown, theme: UiTheme, keybindings: unknown, done: (value: T) => void) => Pane,
      options?: {
        overlay?: boolean;
        overlayOptions?: { width?: number; minWidth?: number; anchor?: string; margin?: number };
      },
    ): Promise<T>;
  };
}

export interface UsageApi {
  on(event: string, handler: (event: unknown, ctx: UsageContext) => unknown): unknown;
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: UsageContext) => Promise<void> | void;
  }): void;
}

export type FetchUsage = (token: string | undefined, signal?: AbortSignal) => Promise<PublicUsage>;

export interface UsageUi {
  refresh(ctx: UsageContext): Promise<PublicUsage | null>;
}

function color(theme: UiTheme | undefined, name: string, text: string): string {
  try {
    return theme?.fg?.(name, text) ?? text;
  } catch {
    return text;
  }
}

class UsagePanel implements Pane {
  constructor(
    private readonly theme: UiTheme,
    private readonly lines: string[],
    private readonly done: (value: boolean) => void,
  ) {}

  render(_width: number): string[] {
    return [
      ...this.lines,
      "",
      color(this.theme, "dim", "Press Enter or Esc to close"),
    ];
  }

  handleInput(data: string): void {
    if (data === "\r" || data === "\n" || data === "\x1b" || data === "q" || data === "Q") this.done(true);
  }

  invalidate(): void { }
}

export function installUsageUI(pi: UsageApi, fetchUsage: FetchUsage): UsageUi {
  let current: PublicUsage | null = null;
  let lastError: string | undefined;
  let inFlight: Promise<PublicUsage | null> | undefined;
  let latestContext: UsageContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function applyStatus(ctx: UsageContext): void {
    if (!ctx.hasUI) return;
    if (!current || ctx.model?.provider !== PROVIDER_ID) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const severity = usageSeverity(current);
    const name = severity === "critical" ? "error" : severity === "warning" ? "warning" : "success";
    ctx.ui.setStatus(STATUS_KEY, color(ctx.ui.theme, name, formatCompact(current)));
  }

  async function refresh(ctx: UsageContext, reportErrors = false): Promise<PublicUsage | null> {
    latestContext = ctx;
    if (inFlight) {
      const usage = await inFlight;
      applyStatus(ctx);
      if (reportErrors && !usage) {
        ctx.ui.notify(lastError ?? "Connect Agent Fan Club with /login before checking usage.", lastError ? "error" : "warning");
      }
      return usage;
    }

    inFlight = (async () => {
      try {
        const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
        if (!token) {
          current = null;
          lastError = undefined;
          applyStatus(ctx);
          if (reportErrors) ctx.ui.notify("Connect Agent Fan Club with /login before checking usage.", "warning");
          return null;
        }
        const usage = await fetchUsage(token, AbortSignal.timeout(15_000));
        current = usage;
        lastError = undefined;
        applyStatus(ctx);
        return usage;
      } catch (error) {
        current = null;
        lastError = error instanceof Error ? error.message : String(error);
        applyStatus(ctx);
        if (reportErrors) ctx.ui.notify(lastError, "error");
        return null;
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  }

  function startTimer(ctx: UsageContext): void {
    latestContext = ctx;
    if (timer) return;
    timer = setInterval(() => {
      if (latestContext) void refresh(latestContext);
    }, REFRESH_MS);
    timer.unref?.();
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    latestContext = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    void refresh(ctx);
    startTimer(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    latestContext = ctx;
    if (debounce) clearTimeout(debounce);
    // Give settlement a moment to reach the usage Durable Object.
    debounce = setTimeout(() => {
      if (latestContext) void refresh(latestContext);
    }, 500);
    debounce.unref?.();
  });

  pi.on("session_shutdown", () => {
    stopTimer();
  });

  pi.registerCommand("afc", {
    description: "Show Agent Fan Club usage limits",
    handler: async (_args, ctx) => {
      const usage = await refresh(ctx, true);
      if (!usage) return;

      const lines = formatDetails(usage);
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const title = color(ctx.ui.theme, "accent", lines[0]!);
      const body = [title, ...lines.slice(1)];
      await ctx.ui.custom<boolean>(
        (_tui, theme, _keybindings, done) => new UsagePanel(theme, body, done),
        { overlay: true, overlayOptions: { width: 64, minWidth: 48, anchor: "center", margin: 1 } },
      );
    },
  });

  return {
    refresh: (ctx) => refresh(ctx),
  };
}
