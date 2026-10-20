import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_dashboard/models")({
  component: Page,
});

function Page() {
  return (
    <section className="p-6">
      <h1 className="text-lg font-medium">Models</h1>
      <p className="mt-2 text-sm text-neutral-500">Model management isn't connected yet.</p>
    </section>
  );
}
