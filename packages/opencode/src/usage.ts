export interface PublicUsageWindow {
  usedPercent: number;
  pendingPercent: number;
  resetsInMs: number;
}

export interface PublicUsage {
  fiveHour: PublicUsageWindow;
  weekly: PublicUsageWindow;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWindow(value: unknown): PublicUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!finiteNumber(record.usedPercent) || !finiteNumber(record.pendingPercent) || !finiteNumber(record.resetsInMs)) return null;
  return {
    usedPercent: Math.max(0, record.usedPercent),
    pendingPercent: Math.max(0, record.pendingPercent),
    resetsInMs: Math.max(0, record.resetsInMs),
  };
}

export function parseUsage(value: unknown): PublicUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const fiveHour = parseWindow(record.fiveHour);
  const weekly = parseWindow(record.weekly);
  return fiveHour && weekly ? { fiveHour, weekly } : null;
}

export class UsageFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UsageFetchError";
  }
}

export async function fetchUsage(apiUrl: string, token: string, signal?: AbortSignal): Promise<PublicUsage> {
  const response = await fetch(`${apiUrl}/api/usage/limits`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
  });
  if (response.status === 401) {
    throw new UsageFetchError("The Agent Fan Club API key is invalid or disabled. Reconnect with /connect.", 401);
  }
  if (!response.ok) throw new UsageFetchError("Couldn't load Agent Fan Club usage. Try again.");
  const usage = parseUsage(await response.json());
  if (!usage) throw new UsageFetchError("Agent Fan Club returned invalid usage data.");
  return usage;
}

export function percent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatReset(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 48) return remainder ? `in ${hours}h ${remainder}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `in ${days}d ${restHours}h` : `in ${days}d`;
}

export function formatCompact(usage: PublicUsage): string {
  return `AFC 5h ${percent(usage.fiveHour.usedPercent)}% · 7d ${percent(usage.weekly.usedPercent)}%`;
}

export function formatDetails(usage: PublicUsage): string {
  const pending = Math.max(usage.fiveHour.pendingPercent, usage.weekly.pendingPercent);
  return [
    "Agent Fan Club usage",
    "",
    `Five-hour  ${percent(usage.fiveHour.usedPercent)}%  resets ${formatReset(usage.fiveHour.resetsInMs)}`,
    `Weekly     ${percent(usage.weekly.usedPercent)}%  resets ${formatReset(usage.weekly.resetsInMs)}`,
    ...(pending >= 0.1 ? ["", `${percent(pending)}% reserved by in-flight requests`] : []),
  ].join("\n");
}

export function usageSeverity(usage: PublicUsage): "ok" | "warning" | "critical" {
  const used = Math.max(
    usage.fiveHour.usedPercent + usage.fiveHour.pendingPercent,
    usage.weekly.usedPercent + usage.weekly.pendingPercent,
  );
  return used >= 95 ? "critical" : used >= 80 ? "warning" : "ok";
}
