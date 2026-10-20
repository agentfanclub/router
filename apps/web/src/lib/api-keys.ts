import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { ApiKey } from "../../../api/src/routes/api-keys";

async function requestKeys<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  setResponseHeader("Cache-Control", "no-store");
  const headers = new Headers(getRequestHeaders());
  headers.set("Content-Type", "application/json");
  const response = await env.API.fetch(`https://api/api/keys${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json<{ error?: string }>().catch(() => null);
    throw new Error(result?.error || "Couldn't update API keys. Try again.");
  }
  return response.json<T>();
}

export const listApiKeys = createServerFn({ method: "GET" }).handler(() => requestKeys<ApiKey[]>(""));

export const createApiKey = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => data)
  .handler(({ data }) => requestKeys<{ key: ApiKey; token: string }>("", "POST", data));

export const updateApiKey = createServerFn({ method: "POST" })
  .validator((data: { id: string; enabled: boolean }) => data)
  .handler(({ data }) => requestKeys<ApiKey>(`/${encodeURIComponent(data.id)}`, "PATCH", { enabled: data.enabled }));

export const deleteApiKey = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(({ data }) => requestKeys<{ success: true }>(`/${encodeURIComponent(data.id)}`, "DELETE"));
