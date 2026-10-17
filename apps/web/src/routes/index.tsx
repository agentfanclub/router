import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const getGreeting = createServerFn({ method: "GET" }).handler(async () => {
  const response = await env.API.fetch("https://api/");
  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }
  return response.text();
});

export const Route = createFileRoute("/")({
  loader: () => getGreeting(),
  component: Home,
});

function Home() {
  const greeting = Route.useLoaderData();
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold">{greeting}</h1>
    </main>
  );
}
