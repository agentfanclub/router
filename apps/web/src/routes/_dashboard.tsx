import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { authClient } from "../lib/auth-client";
import { getSession } from "../lib/session";

const dashboardTabs = [
  { to: "/", label: "Overview" },
  { to: "/logs", label: "Logs" },
  { to: "/models", label: "Models" },
  { to: "/api-keys", label: "API Keys" },
  { to: "/connections", label: "Connections" },
] as const;

export const Route = createFileRoute("/_dashboard")({
  loader: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    return session;
  },
  component: Dashboard,
});

function Dashboard() {
  const { user } = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Couldn't sign out.");
      await router.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't sign out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-white text-neutral-800 scheme-light">
      <header className="flex h-14 shrink-0 items-center justify-between gap-6 px-[18px] max-[480px]:gap-3 max-[480px]:px-2.5">
        <a href="/" aria-label="Router home" className="shrink-0 rounded-[3px] ">
          <img src="/agent-fan-club.png" alt="Agent fan club" width="980" height="202" className="block h-auto w-[140px] max-[480px]:w-28" />
        </a>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex min-w-0 cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[7px] text-[13px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 data-[state=open]:bg-neutral-100 data-[state=open]:text-neutral-800">
              <span className="truncate">{user.email}</span>
              <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="w-[180px] max-w-[calc(100vw_-_32px)] rounded-[7px] border-neutral-200 bg-white p-1 text-neutral-800 shadow-none">
            <DropdownMenuItem
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                void signOut();
              }}
              aria-busy={busy}
              className="w-full cursor-pointer rounded px-2.5 py-2 text-left text-[13px] text-red-600 focus:bg-red-50 focus:text-red-700 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700 data-[disabled]:cursor-wait data-[disabled]:text-neutral-500"
            >
              {busy ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
            {error && <p role="alert" className="px-3 pb-2 text-xs leading-5 text-red-700">{error}</p>}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex min-h-0 flex-1 flex-col border-t border-neutral-200 bg-neutral-50">
        <nav aria-label="Dashboard" className="flex shrink-0 gap-6 overflow-x-auto overflow-y-hidden border-b border-neutral-200 px-[22px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[480px]:gap-5 max-[480px]:px-4">
          {dashboardTabs.map((item) => (
            <Link key={item.to} to={item.to} activeOptions={{ exact: true }} className="inline-flex min-h-[46px] shrink-0 cursor-pointer items-center whitespace-nowrap border-b-[3px] border-transparent text-[13px] font-normal text-neutral-500 aria-[current=page]:border-neutral-700 aria-[current=page]:text-neutral-800 ">
              {item.label}
            </Link>
          ))}
          {user.role === "admin" && (
            <Link to="/users" activeOptions={{ exact: true }} className="inline-flex min-h-[46px] shrink-0 cursor-pointer items-center whitespace-nowrap border-b-[3px] border-transparent text-[13px] font-normal text-neutral-500 aria-[current=page]:border-neutral-700 aria-[current=page]:text-neutral-800">
              Admin
            </Link>
          )}
        </nav>
        <main id="dashboard-content" className="min-h-0 flex-1 overflow-y-auto bg-white">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
