import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
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

export const getMyUsage = createServerFn({ method: "GET" }).handler(() => requestUsage<UsageStatus>("/api/usage/me"));

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
  .handler(({ data }) => requestUsage<AdminUsage>(`/api/admin/usage?days=${data.days}`));

export const updateUserLimits = createServerFn({ method: "POST" })
  .validator((data: { userId: string; fiveHourMicro: number | null; weeklyMicro: number | null }) => data)
  .handler(({ data }) =>
    requestUsage<{ userId: string; fiveHourMicro: number | null; weeklyMicro: number | null }>(
      `/api/admin/users/${encodeURIComponent(data.userId)}/limits`,
      "PUT",
      { fiveHourMicro: data.fiveHourMicro, weeklyMicro: data.weeklyMicro },
    ));
