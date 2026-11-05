import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { ByokKeyRow } from "../../../api/src/routes/byok";

async function requestByok<T>(path: string, method = "GET", body?: unknown): Promise<T> {
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
    throw new Error(result?.error || "Couldn't update personal Lumen keys. Try again.");
  }
  return response.json<T>();
}

export const listByokKeys = createServerFn({ method: "GET" }).handler(() =>
  requestByok<ByokKeyRow[]>("/api/byok/keys"));

export const addByokKey = createServerFn({ method: "POST" })
  .validator((data: { label: string; key: string }) => data)
  .handler(({ data }) => requestByok<ByokKeyRow>("/api/byok/keys", "POST", data));

export const deleteByokKey = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(({ data }) =>
    requestByok<{ success: true }>(`/api/byok/keys/${encodeURIComponent(data.id)}`, "DELETE"));
