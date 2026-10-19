import { Effect } from "effect";
import { createAuth } from "./auth";

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/auth/")) {
      return createAuth(env).handler(request);
    }
    if (new URL(request.url).pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    return Effect.runPromise(Effect.sync(() => new Response("hello world")));
  },
} satisfies ExportedHandler<Env>;
