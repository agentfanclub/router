import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/session";
import { listUsers } from "../lib/users";

export const Route = createFileRoute("/_dashboard/users")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    if (session.user.role !== "admin") throw redirect({ to: "/" });
  },
  loader: () => listUsers(),
  component: Page,
});

function Page() {
  const users = Route.useLoaderData();

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
      <h1 className="mb-6 text-lg font-medium">Users</h1>
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
    </section>
  );
}
