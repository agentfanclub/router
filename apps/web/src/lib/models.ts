import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { ModelCatalog } from "../../../api/src/routes/models";

export const listModels = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("Cache-Control", "no-store");
  const response = await env.API.fetch("https://api/api/models", {
    headers: getRequestHeaders(),
  });
  if (!response.ok) throw new Error("Couldn't load models. Try again.");
  return Object.values(await response.json<ModelCatalog>());
});
