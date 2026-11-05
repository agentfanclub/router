import { createHash } from "node:crypto";

// Default usage caps. $10.00 per five-hour window and $50.00 per week.
// Per-user overrides live in the usage_limit table.
export const DEFAULT_FIVE_HOUR_LIMIT_MICRO = 10_000_000;
export const DEFAULT_WEEKLY_LIMIT_MICRO = 50_000_000;

export interface UsageLimits {
  fiveHourMicro: number;
  weeklyMicro: number;
}

// Formats integer micro-dollars for people: four decimals under a dollar so
// per-request costs stay readable, two above.
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

// Prices are USD per million tokens, matching the model catalog, so
// tokens * price is exactly micro-dollars with no unit juggling.
export interface RoutePrice {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export function computeCostMicro(usage: ParsedUsage, price: RoutePrice): number {
  // OpenAI-compatible prompt_tokens includes cached tokens; price them separately.
  // Clamp defensively so cached can never exceed (or be billed beyond) input.
  const cachedTokens = Math.min(usage.cachedTokens, usage.inputTokens);
  const uncachedInput = usage.inputTokens - cachedTokens;
  return Math.round(
    uncachedInput * price.input +
    cachedTokens * price.cacheRead +
    usage.outputTokens * price.output,
  );
}

export function estimateCostMicro(
  { inputEstimateTokens, maxOutputTokens }: { inputEstimateTokens: number; maxOutputTokens: number },
  price: RoutePrice,
): number {
  return Math.round(inputEstimateTokens * price.input + maxOutputTokens * price.output);
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Parses the `usage` object from an OpenAI-compatible chat completion response.
export function parseOpenAiUsage(raw: unknown): ParsedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const inputTokens = numberField(record.prompt_tokens);
  const outputTokens = numberField(record.completion_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const details = record.prompt_tokens_details;
  const cachedRaw = details && typeof details === "object"
    ? numberField((details as Record<string, unknown>).cached_tokens)
    : null;
  return {
    inputTokens,
    outputTokens,
    cachedTokens: Math.min(cachedRaw ?? 0, inputTokens),
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part) {
      const value = (part as Record<string, unknown>).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

// Derives a stable session tag from a conversation's first messages. The
// system prompt and first user message never change as a conversation grows,
// so every turn of one conversation hashes to the same ID while different
// conversations do not. It is a routing and grouping hint, not an identifier
// with security meaning.
export function deriveSessionId(messages: unknown): string {
  const list = Array.isArray(messages) ? messages : [];
  let system = "";
  let firstUser = "";
  let fallback = "";
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const text = messageText(record.content);
    if (record.role === "system" && !system) system = text;
    else if (record.role === "user" && !firstUser) firstUser = text;
    if (!fallback && text) fallback = text;
  }
  const anchor = firstUser ? `${system}\u0000${firstUser}` : (system || fallback || crypto.randomUUID());
  return `ses_${createHash("sha256").update(anchor).digest("hex").slice(0, 16)}`;
}

// Older router tags were bare hashes. OpenCode's existing IDs stay unchanged.
export function normalizeSessionId(sessionId: string): string {
  return /^[0-9a-f]{16}$/.test(sessionId) ? `ses_${sessionId}` : sessionId;
}
