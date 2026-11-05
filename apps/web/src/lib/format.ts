// Client-safe formatting helpers. The API keeps its own copy alongside the
// usage utilities so client bundles never import server modules.

export function formatUsdMicro(micro: number): string {
  const dollars = micro / 1_000_000;
  const fractionDigits = Math.abs(dollars) < 1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(dollars);
}

export function formatDurationMs(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 48) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatSeconds(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}s`;
}

export function formatTokens(tokens: number | null): string {
  if (tokens === null) return "—";
  return tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

// Formats an instant in the viewer's own timezone. Omitting `timeZone` makes
// Intl use the browser's zone, so timestamps match the clock the person reads.
export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    hour12: false,
  }).format(typeof value === "string" ? new Date(value) : value);
}

// Short label for the viewer's zone (e.g. "PST", "GMT+5"), for table headers
// and fields where the previous UTC-only UI made the zone explicit. Returns
// null if the runtime cannot name the zone, so callers can fall back to local.
export function localTimeZoneLabel(value: string | Date = new Date()): string | null {
  const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(typeof value === "string" ? new Date(value) : value);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? null;
}
