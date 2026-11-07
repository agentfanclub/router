import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useTheme } from "../components/theme-provider";
import { authClient } from "../lib/auth-client";
import { getSession } from "../lib/session";

const dashboardTabs = [
  { to: "/", label: "Overview" },
  { to: "/logs", label: "Logs" },
  { to: "/models", label: "Models" },
  { to: "/api-keys", label: "API Keys" },
  { to: "/setup", label: "Setup" },
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
  const { theme, setTheme } = useTheme();
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
    <div className="flex h-dvh flex-col overflow-hidden bg-white dark:bg-neutral-950 text-neutral-800 dark:text-neutral-100">
      <header className="flex h-14 shrink-0 items-center justify-between gap-6 px-[18px] max-[480px]:gap-3 max-[480px]:px-2.5">
        <a href="/" aria-label="Router home" className="shrink-0 rounded-[3px] ">
          <img src="/agent-fan-club.png" alt="Agent fan club" width="980" height="202" className="block h-auto w-[140px] max-[480px]:w-28" />
        </a>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex min-w-0 cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[7px] text-[13px] text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-800 dark:hover:text-neutral-100 data-[state=open]:bg-neutral-100 dark:data-[state=open]:bg-neutral-800 data-[state=open]:text-neutral-800 dark:data-[state=open]:text-neutral-100">
              <span className="truncate">{user.email}</span>
              <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="w-[180px] max-w-[calc(100vw_-_32px)] rounded-[7px] border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 p-1 text-neutral-800 dark:text-neutral-100 shadow-none">
            <DropdownMenuLabel className="px-2.5 text-xs font-normal text-neutral-500 dark:text-neutral-400">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark") setTheme(value);
            }}>
              {(["system", "light", "dark"] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value} className="cursor-pointer text-[13px] focus:bg-neutral-100 dark:focus:bg-neutral-800">
                  {value === "system" ? "System" : value === "light" ? "Light" : "Dark"}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator className="mx-0 bg-neutral-200 dark:bg-neutral-700" />
            <DropdownMenuItem
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                void signOut();
              }}
              aria-busy={busy}
              className="w-full cursor-pointer rounded px-2.5 py-2 text-left text-[13px] text-red-600 dark:text-red-400 focus:bg-red-50 dark:focus:bg-red-950 focus:text-red-700 dark:focus:text-red-400 data-[highlighted]:bg-red-50 dark:data-[highlighted]:bg-red-950 data-[highlighted]:text-red-700 dark:data-[highlighted]:text-red-400 data-[disabled]:cursor-wait data-[disabled]:text-neutral-500 dark:data-[disabled]:text-neutral-400"
            >
              {busy ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
            {error && <p role="alert" className="px-3 pb-2 text-xs leading-5 text-red-700 dark:text-red-400">{error}</p>}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex min-h-0 flex-1 flex-col border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900">
        <nav aria-label="Dashboard" className="flex shrink-0 gap-6 overflow-x-auto overflow-y-hidden border-b border-neutral-200 dark:border-neutral-700 px-[22px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[480px]:gap-5 max-[480px]:px-4">
          {dashboardTabs.map((item) => (
            <Link key={item.to} to={item.to} activeOptions={{ exact: true, includeSearch: false }} className="inline-flex min-h-[46px] shrink-0 cursor-pointer items-center whitespace-nowrap border-b-[3px] border-transparent text-[13px] font-normal text-neutral-500 dark:text-neutral-400 aria-[current=page]:border-neutral-700 dark:aria-[current=page]:border-neutral-200 aria-[current=page]:text-neutral-800 dark:aria-[current=page]:text-neutral-100 ">
              {item.label}
            </Link>
          ))}
          {user.role === "admin" && (
            <>
              <Link to="/leaderboard" activeOptions={{ exact: true, includeSearch: false }} className="inline-flex min-h-[46px] shrink-0 cursor-pointer items-center whitespace-nowrap border-b-[3px] border-transparent text-[13px] font-normal text-neutral-500 dark:text-neutral-400 aria-[current=page]:border-neutral-700 dark:aria-[current=page]:border-neutral-200 aria-[current=page]:text-neutral-800 dark:aria-[current=page]:text-neutral-100">
                Leaderboard
              </Link>
              <Link to="/admin" activeOptions={{ exact: true, includeSearch: false }} className="inline-flex min-h-[46px] shrink-0 cursor-pointer items-center whitespace-nowrap border-b-[3px] border-transparent text-[13px] font-normal text-neutral-500 dark:text-neutral-400 aria-[current=page]:border-neutral-700 dark:aria-[current=page]:border-neutral-200 aria-[current=page]:text-neutral-800 dark:aria-[current=page]:text-neutral-100">
                Admin
              </Link>
            </>
          )}
        </nav>
        <main id="dashboard-content" className="relative min-h-0 flex-1 overflow-y-auto bg-white dark:bg-neutral-950">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
