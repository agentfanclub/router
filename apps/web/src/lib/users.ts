import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { User } from "../../../api/src/routes/users";

export const listUsers = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", "no-store");
  const response = await env.API.fetch("https://api/api/users", {
    headers: getRequestHeaders(),
  });
  if (!response.ok) throw new Error("Couldn't load users. Try again.");
  return response.json<User[]>();
});
