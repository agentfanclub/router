import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { LumenUsage, TokenLeaderboard, User } from "../../../api/src/routes/admin";

export const listUsers = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", "no-store");
  const response = await env.API.fetch("https://api/api/admin/users", {
    headers: getRequestHeaders(),
  });
  if (!response.ok) throw new Error("Couldn't load users. Try again.");
  return response.json<User[]>();
});

export const getTokenLeaderboard = createServerFn({ method: "GET" })
  .validator((data: { days: 0 | 7 | 30 }) => data)
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "no-store");
    const response = await env.API.fetch(`https://api/api/admin/token-leaderboard?days=${data.days}`, {
      headers: getRequestHeaders(),
    });
    if (!response.ok) {
      const result = await response.json<{ error?: string }>().catch(() => null);
      throw new Error(result?.error || "Couldn't load the token leaderboard. Try again.");
    }
    return response.json<TokenLeaderboard>();
  });

export const getLumenUsage = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", "no-store");
  const response = await env.API.fetch("https://api/api/admin/lumen-usage", {
    headers: getRequestHeaders(),
  });
  if (!response.ok) {
    const result = await response.json<{ error?: string }>().catch(() => null);
    throw new Error(result?.error || "Couldn't load Lumen usage. Try again.");
  }
  return response.json<LumenUsage>();
});
