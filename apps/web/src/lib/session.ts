import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

type Session = { user: { id: string; email: string; name: string }; session: { id: string } };

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const response = await env.API.fetch("https://api/api/auth/get-session", {
    headers: getRequestHeaders(),
  });
  if (!response.ok) throw new Error("Unable to load your session.");
  return response.json<Session | null>();
});
