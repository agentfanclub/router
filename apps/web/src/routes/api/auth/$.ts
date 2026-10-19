import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

// Keep auth on the web origin so Better Auth's host-only cookies work for SSR too.
const proxy = ({ request }: { request: Request }) => env.API.fetch(request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: proxy, POST: proxy } },
});
