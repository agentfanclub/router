import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_dashboard/")({
  component: Page,
});

function Page() {
  return (
    <section className="p-6">
      <h1 className="text-lg font-medium">Overview</h1>
      <p className="mt-2 text-sm text-neutral-500">Your router activity will appear here.</p>
    </section>
  );
}
