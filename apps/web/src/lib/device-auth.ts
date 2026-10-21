import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { DeviceApproval } from "../../../api/src/routes/device-auth";

function validateCode(code: unknown): string {
  if (typeof code !== "string" || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(code)) {
    throw new Error("Invalid connection code. Start again in your terminal.");
  }
  return code;
}

async function requestApproval(code: string, decision?: "approve" | "deny") {
  setResponseHeader("Cache-Control", "no-store");
  const headers = new Headers(getRequestHeaders());
  headers.set("Content-Type", "application/json");
  const response = await env.API.fetch(`https://api/api/device/authorization/${encodeURIComponent(code)}`, {
    method: decision ? "POST" : "GET",
    headers,
    body: decision ? JSON.stringify({ decision }) : undefined,
  });
  if (!response.ok) {
    const result = await response.json<{ error?: string }>().catch(() => null);
    throw new Error(result?.error || "Couldn't load this connection. Try again.");
  }
  return response.json<DeviceApproval>();
}

export const getDeviceApproval = createServerFn({ method: "GET" })
  .validator((data: { code: string }) => ({ code: validateCode(data.code) }))
  .handler(({ data }) => requestApproval(data.code));

export const answerDeviceApproval = createServerFn({ method: "POST" })
  .validator((data: { code: string; decision: "approve" | "deny" }) => {
    if (data.decision !== "approve" && data.decision !== "deny") throw new Error("Invalid decision.");
    return { code: validateCode(data.code), decision: data.decision };
  })
  .handler(({ data }) => requestApproval(data.code, data.decision));
