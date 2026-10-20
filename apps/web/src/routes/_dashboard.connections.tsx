import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_dashboard/connections")({
  component: Page,
});

function Page() {
  return (
    <section className="p-6">
      <h1 className="text-lg font-medium">Connections</h1>
      <p className="mt-2 text-sm text-neutral-500">Connection management isn't connected yet.</p>
    </section>
  );
}
