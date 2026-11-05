import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { UsageLogFeed, UsageSessionFeed, UsageStatus } from "../../../api/src/routes/usage";
import type { AdminUsage } from "../../../api/src/routes/admin";

async function requestUsage<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  setResponseHeader("Cache-Control", "no-store");
  const headers = new Headers(getRequestHeaders());
  headers.set("Content-Type", "application/json");
  const response = await env.API.fetch(`https://api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json<{ error?: string }>().catch(() => null);
    throw new Error(result?.error || "Couldn't load usage. Try again.");
  }
  return response.json<T>();
}

// The viewer's UTC offset in minutes east of UTC, so the API buckets chart
// days on their calendar. The browser writes this cookie at boot because a
// server render would otherwise report the Worker's own zone (always UTC).
function tzOffset(): number {
  const raw = getCookie("tzOffset");
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

// Usage payloads carry the offset back so the chart can lay out its day axis
// from the same value on both the server render and the browser, avoiding a
// hydration mismatch from clock-dependent labels.
export type WithTz<T> = T & { tzOffset: number };

export const getMyUsage = createServerFn({ method: "GET" }).handler(async () => {
  const offset = tzOffset();
  const usage = await requestUsage<UsageStatus>(`/api/usage/me?tzOffset=${offset}`);
  return { ...usage, tzOffset: offset } satisfies WithTz<UsageStatus>;
});

export const getUsageLogs = createServerFn({ method: "GET" })
  .validator((data: { sessionId?: string; model?: string; limit?: number; offset?: number }) => data)
  .handler(({ data }) => {
    const params = new URLSearchParams();
    if (data.sessionId) params.set("session", data.sessionId);
    if (data.model) params.set("model", data.model);
    params.set("limit", String(data.limit ?? 100));
    if (data.offset) params.set("offset", String(data.offset));
    return requestUsage<UsageLogFeed>(`/api/usage/logs?${params}`);
  });

export const getUsageSessions = createServerFn({ method: "GET" })
  .validator((data: { model?: string; page?: number }) => data)
  .handler(({ data }) => {
    const params = new URLSearchParams({ page: String(data.page ?? 0) });
    if (data.model) params.set("model", data.model);
    return requestUsage<UsageSessionFeed>(`/api/usage/sessions?${params}`);
  });

export const getAdminUsage = createServerFn({ method: "GET" })
  .validator((data: { days: number }) => data)
  .handler(async ({ data }) => {
    const offset = tzOffset();
    const usage = await requestUsage<AdminUsage>(`/api/admin/usage?days=${data.days}&tzOffset=${offset}`);
    return { ...usage, tzOffset: offset } satisfies WithTz<AdminUsage>;
  });

export const updateUserLimits = createServerFn({ method: "POST" })
  .validator((data: { userId: string; fiveHourMicro: number | null; weeklyMicro: number | null }) => data)
  .handler(({ data }) =>
    requestUsage<{ userId: string; fiveHourMicro: number | null; weeklyMicro: number | null }>(
      `/api/admin/users/${encodeURIComponent(data.userId)}/limits`,
      "PUT",
      { fiveHourMicro: data.fiveHourMicro, weeklyMicro: data.weeklyMicro },
    ));
