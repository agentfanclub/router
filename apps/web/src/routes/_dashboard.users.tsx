import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/session";
import { getLumenUsage, listUsers } from "../lib/admin";

export const Route = createFileRoute("/_dashboard/users")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    if (session.user.role !== "admin") throw redirect({ to: "/" });
  },
  loader: async () => {
    const [users, lumenUsage] = await Promise.all([
      listUsers(),
      getLumenUsage().then(
        (usage) => ({ usage, error: null }),
        (error: unknown) => ({ usage: null, error: error instanceof Error ? error.message : "Couldn't load Lumen usage." }),
      ),
    ]);
    return { users, lumenUsage };
  },
  component: Page,
});

function Page() {
  const { users, lumenUsage: lumenResult } = Route.useLoaderData();
  const lumenUsage = lumenResult.usage;
  const usageFields = lumenUsage && [
    ["Requests", lumenUsage.requests.toLocaleString("en-US")],
    ["Input tokens", lumenUsage.input_tokens.toLocaleString("en-US")],
    ["Output tokens", lumenUsage.output_tokens.toLocaleString("en-US")],
    ["Total tokens", lumenUsage.total_tokens.toLocaleString("en-US")],
    ["Audio seconds", lumenUsage.audio_seconds.toLocaleString("en-US", { maximumFractionDigits: 6 })],
    ["Coins spent", lumenUsage.cost.toLocaleString("en-US", { maximumFractionDigits: 8 })],
    ["Coins available", lumenUsage.coins_available === -2 ? "Unlimited"
      : lumenUsage.coins_available === null ? "No pool or blocked"
      : lumenUsage.coins_available.toLocaleString("en-US", { maximumFractionDigits: 8 })],
    ["Last used", lumenUsage.last_used_at === null ? "Never"
      : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
      }).format(new Date(lumenUsage.last_used_at)) + " UTC"],
  ];

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
      <h1 className="mb-6 text-lg font-medium">Admin</h1>
      <h2 className="mb-4 text-base font-medium">Users</h2>
      <div className="dashboard-table-frame overflow-x-auto bg-[#eeeeee]">
        <table className="dashboard-table users-table w-full min-w-[540px] border-separate border-spacing-0 text-left text-sm text-neutral-600">
          <caption className="sr-only">All users and their roles.</caption>
          <thead>
            <tr className="text-neutral-500">
              <th scope="col" className="px-6 py-2.5 font-medium">Name</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Email</th>
              <th scope="col" className="px-6 py-2.5 font-medium">Role</th>
            </tr>
          </thead>
          <tbody className="bg-white" data-single-row={users.length === 1 ? "true" : undefined}>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="truncate px-6 py-3 text-neutral-800" title={user.name}>{user.name || "—"}</td>
                <td className="truncate px-3 py-3" title={user.email}>{user.email}</td>
                <td className="px-6 py-3">
                  <span className="rounded border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs">{user.role}</span>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={3} className="col-span-full px-6 py-8 text-center text-neutral-500">No users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <section className="mt-10" aria-labelledby="lumen-usage-heading">
        <h2 id="lumen-usage-heading" className="text-base font-medium">Lumen usage</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Cumulative usage across all users sharing the router's Lumen API key. The available coin balance is shared across the Lumen account.
        </p>
        {usageFields ? (
          <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-4">
            {usageFields.map(([label, value]) => (
              <div key={label} className="bg-white p-4">
                <dt className="text-xs text-neutral-500">{label}</dt>
                <dd className="mt-2 break-words text-sm font-medium tabular-nums text-neutral-800">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="alert" className="mt-4 text-sm text-red-700">{lumenResult.error} Reload the page to try again.</p>
        )}
      </section>
    </section>
  );
}
