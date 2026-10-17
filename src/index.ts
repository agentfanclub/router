import { Effect } from "effect";

export default {
  async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    return Effect.runPromise(Effect.sync(() => new Response("hello world")));
  },
} satisfies ExportedHandler<Env>;
