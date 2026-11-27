import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { DailyUsage, type ChartUnit } from "../components/daily-usage";
import { useEffect, useState } from "react";
import { getSession } from "../lib/session";
import { getLifetimeUsage, getLumenUsage, listUsers } from "../lib/admin";
import { getAdminUsage, getUserWindows, resetUserWindow, updateUserLimits } from "../lib/usage";
import { formatDurationMs, formatUsdMicro, localTimeZoneLabel } from "../lib/format";
import type { AdminUser, AdminUserWindows, AdminUsers, LumenUsage } from "../../../api/src/routes/admin";
import { DataTable, TableBody, TableHead, Td, Th } from "../components/data-table";

export const DEFAULT_FIVE_HOUR_LIMIT_MICRO = 10_000_000;
export const DEFAULT_WEEKLY_LIMIT_MICRO = 50_000_000;

export const Route = createFileRoute("/_dashboard/admin")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    if (session.user.role !== "admin") throw redirect({ to: "/" });
  },
  loader: async () => {
    const [users, lifetimeUsage, adminUsage] = await Promise.all([
      listUsers({ data: { page: 0 } }),
      getLifetimeUsage().then(
        (usage) => ({ usage, error: null }),
        (error: unknown) => ({ usage: null, error: error instanceof Error ? error.message : "Couldn't load lifetime usage." }),
      ),
      getAdminUsage({ data: { days: 30 } }).then(
        (usage) => ({ usage, error: null }),
        (error: unknown) => ({ usage: null, error: error instanceof Error ? error.message : "Couldn't load usage logs." }),
      ),
    ]);
    return { users, lifetimeUsage, adminUsage };
  },
  component: Page,
});

function Page() {
  const { users, lifetimeUsage: lifetimeResult, adminUsage } = Route.useLoaderData();
  const [days, setDays] = useState(30);
  const [unit, setUnit] = useState<ChartUnit>("charge");
  const [adminResult, setAdminResult] = useState(adminUsage);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (days === 30) {
      setAdminResult(adminUsage);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getAdminUsage({ data: { days } }).then(
      (usage) => { if (!cancelled) setAdminResult({ usage, error: null }); },
      (error: unknown) => { if (!cancelled) setAdminResult({ usage: null, error: error instanceof Error ? error.message : "Couldn't load usage logs." }); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, adminUsage]);
  const lifetime = lifetimeResult.usage;
  const usageFields = lifetime && [
    ["Requests", lifetime.requests.toLocaleString("en-US")],
    ["Input tokens", lifetime.inputTokens.toLocaleString("en-US")],
    ["Output tokens", lifetime.outputTokens.toLocaleString("en-US")],
    ["Total tokens", lifetime.totalTokens.toLocaleString("en-US")],
    ["Club charges", formatUsdMicro(lifetime.clubChargeMicro)],
    ["Personal charges", formatUsdMicro(lifetime.personalChargeMicro)],
    ["Our cost", formatUsdMicro(lifetime.costMicro)],
    ["Sessions", lifetime.sessions.toLocaleString("en-US")],
  ];

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">

      <h1 className="mb-6 text-lg font-medium">Admin Panel</h1>

      <section className="mb-6" aria-labelledby="lifetime-usage-heading">
        <h2 id="lifetime-usage-heading" className="text-base font-medium">Lifetime router usage</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Recorded usage across all users and providers, including club and personal keys.
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
          <p role="alert" className="mt-4 text-sm text-red-700">{lifetimeResult.error} Reload the page to try again.</p>
        )}
      </section>

      <ProviderUsage />
      <UsersTable initial={users} />

      <section className="mb-6" aria-label="Router usage">
        {loading ? <p role="status" className="mt-4 text-sm text-neutral-500">Loading usage…</p> : adminResult.usage ? (
          <>
            <DailyUsage
              history={adminResult.usage.history.map((row) => ({ day: row.day, model: row.model, value: unit === "tokens" ? row.tokens : (unit === "charge" ? row.chargeMicro : row.costMicro) / 1_000_000 }))}
              models={[...new Set(adminResult.usage.history.map((row) => row.model))]}
              days={days}
              onDaysChange={setDays}
              unit={unit}
              onUnitChange={setUnit}
              tzOffset={adminResult.usage.tzOffset}
              title={unit === "charge" ? "Daily charges in coins" : unit === "cost" ? "Daily upstream cost in coins" : "Daily token usage"}
              description="Total usage across all users, including club and personal keys"
            />

            {adminResult.usage.perModel.length > 0 && (
              <DataTable variant="models-usage" minWidth={640} caption="Charges at router prices and upstream cost per model over the selected range." className="mt-6">
                <TableHead>
                  <Th pad="start" className="px-5">Model</Th>
                  <Th>Requests</Th>
                  <Th>Input tokens</Th>
                  <Th>Output tokens</Th>
                  <Th>Charged</Th>
                  <Th pad="end" className="px-5">Our cost</Th>
                </TableHead>
                <TableBody
                  rows={adminResult.usage.perModel}
                  rowKey={(row) => row.model}
                  columns={6}
                  renderRow={(row) => (
                    <>
                      <Td pad="start" className="truncate px-5 text-neutral-800" title={row.model}>{row.model}</Td>
                      <Td className="tabular-nums">{row.requests.toLocaleString("en-US")}</Td>
                      <Td className="tabular-nums">{row.inputTokens.toLocaleString("en-US")}</Td>
                      <Td className="tabular-nums">{row.outputTokens.toLocaleString("en-US")}</Td>
                      <Td className="whitespace-nowrap tabular-nums">{formatUsdMicro(row.chargeMicro)}</Td>
                      <Td pad="end" className="whitespace-nowrap px-5 tabular-nums">{formatUsdMicro(row.costMicro)}</Td>
                    </>
                  )}
                />
              </DataTable>
            )}
          </>
        ) : (
          <p role="alert" className="mt-4 text-sm text-red-700">{adminResult.error} Reload the page to try again.</p>
        )}
      </section>
    </section>
  );
}

function UsersTable({ initial }: { initial: AdminUsers }) {
  const [result, setResult] = useState(initial);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (page === 0) {
      setResult(initial);
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void listUsers({ data: { page } }).then(
      (users) => { if (!cancelled) setResult(users); },
      (error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : "Couldn't load users."); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, initial, retry]);

  return (
    <section className="mb-6" aria-labelledby="users-heading" aria-busy={loading}>
      <h2 id="users-heading" className="text-base font-medium">Users</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Sorted by lifetime tokens, highest first. Spend and sessions are lifetime totals. Expand a user to see their current windows and limits.
      </p>
      <div className="dashboard-table-frame mt-6 max-w-[960px] overflow-x-auto bg-[#eeeeee] text-sm text-neutral-600">
        <div style={{ minWidth: 860 }}>
          <div aria-hidden="true" className="users-row py-2.5 pr-5 font-medium text-neutral-500">
            <span />
            <span>Name</span>
            <span>Email</span>
            <span>Role</span>
            <span>Lifetime tokens</span>
            <span title="Charged at router prices, and what upstreams charged the club">Charged / our cost</span>
            <span>Limits (5h / week)</span>
          </div>
          <ul className="overflow-hidden rounded-[12px] bg-white">
            {result.users.map((user) => <UserRow key={user.id} user={user} />)}
            {result.users.length === 0 && <li className="px-6 py-8 text-center text-neutral-500">No users yet.</li>}
          </ul>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <button type="button" disabled={loading || result.page === 0} onClick={() => setPage(result.page - 1)} className="rounded border border-neutral-200 px-3 py-1.5 disabled:opacity-40">Previous</button>
        <span role="status" className="text-neutral-500">{loading ? "Loading users…" : `Page ${result.page + 1}`}</span>
        <button type="button" disabled={loading || !result.hasMore} onClick={() => setPage(result.page + 1)} className="rounded border border-neutral-200 px-3 py-1.5 disabled:opacity-40">Next</button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
    </section>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const [open, setOpen] = useState(false);
  const fiveHour = user.fiveHourMicro ?? DEFAULT_FIVE_HOUR_LIMIT_MICRO;
  const weekly = user.weeklyMicro ?? DEFAULT_WEEKLY_LIMIT_MICRO;

  return (
    <li className="border-b border-neutral-100 last:border-b-0">
      <details className="group" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="users-row cursor-pointer list-none py-3 pr-5 hover:bg-neutral-50 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="size-4 justify-self-center text-neutral-400 transition-transform group-open:rotate-90" />
          <span className="truncate text-neutral-800" title={user.name}>{user.name || "—"}</span>
          <span className="truncate" title={user.email}>{user.email}</span>
          <span>
            <span className="rounded border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs">{user.role}</span>
          </span>
          <span className="tabular-nums">{user.totalTokens.toLocaleString("en-US")}</span>
          <span className="whitespace-nowrap tabular-nums">
            <span className="text-neutral-800">{formatUsdMicro(user.clubChargeMicro)}</span>
            <span className="text-neutral-400"> / {formatUsdMicro(user.costMicro)}</span>
          </span>
          <span className="whitespace-nowrap tabular-nums">
            {formatUsdMicro(fiveHour)} / {formatUsdMicro(weekly)}
            {(user.fiveHourMicro !== null || user.weeklyMicro !== null) && <span className="ml-1 text-xs text-neutral-400">custom</span>}
          </span>
        </summary>
        {open && (
          <div className="grid gap-5 border-t border-neutral-100 bg-neutral-50/60 px-5 py-4 pl-12">
            <UserWindows
              key={`${fiveHour}:${weekly}`}
              userId={user.id}
              name={user.name || user.email}
            />
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div>
                <h3 className="text-xs font-medium text-neutral-500">Limits</h3>
                <LimitsEditor
                  key={`${user.id}:${user.fiveHourMicro}:${user.weeklyMicro}`}
                  userId={user.id}
                  fiveHourMicro={user.fiveHourMicro}
                  weeklyMicro={user.weeklyMicro}
                />
              </div>
              <dl className="flex gap-6 text-xs">
                {([
                  ["Requests", user.requests.toLocaleString("en-US")],
                  ["Sessions", user.sessions.toLocaleString("en-US")],
                  ["Personal key", formatUsdMicro(user.personalChargeMicro)],
                ] as const).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-neutral-500">{label}</dt>
                    <dd className="mt-1 tabular-nums text-neutral-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
      </details>
    </li>
  );
}

const WINDOW_LABELS = { five_hour: "5-hour window", weekly: "Weekly window" } as const;

function UserWindows({ userId, name }: { userId: string; name: string }) {
  const [windows, setWindows] = useState<AdminUserWindows | null>(null);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState<keyof typeof WINDOW_LABELS | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError("");
    void getUserWindows({ data: { userId } }).then(
      (result) => { if (!cancelled) setWindows(result); },
      (error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : "Couldn't load usage."); },
    );
    return () => { cancelled = true; };
  }, [userId, retry]);

  async function reset(window: keyof typeof WINDOW_LABELS) {
    if (!confirm(`Reset ${name}'s ${WINDOW_LABELS[window].toLowerCase()}? Their spend in it goes back to $0.`)) return;
    setResetting(window);
    setError("");
    try {
      setWindows(await resetUserWindow({ data: { userId, window } }));
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Couldn't reset usage.");
    } finally {
      setResetting(null);
    }
  }

  if (!windows) {
    return error
      ? <p role="alert" className="text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>
      : <p role="status" className="text-sm text-neutral-500">Loading current usage…</p>;
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["five_hour", "weekly"] as const).map((key) => {
          const window = key === "five_hour" ? windows.fiveHour : windows.weekly;
          const percent = window.limitMicro > 0 ? Math.min(100, (window.usedMicro / window.limitMicro) * 100) : 0;
          const capped = window.usedMicro >= window.limitMicro;
          return (
            <div key={key} className="rounded-lg border border-neutral-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-neutral-500">{WINDOW_LABELS[key]}</h3>
                  <p className="mt-1 tabular-nums text-neutral-800">
                    {formatUsdMicro(window.usedMicro)} <span className="text-neutral-400">of {formatUsdMicro(window.limitMicro)}</span>
                  </p>
                </div>
                <button
                  type="button"
                  disabled={resetting !== null || window.usedMicro === 0}
                  onClick={() => void reset(key)}
                  className="cursor-pointer rounded border border-neutral-200 px-2.5 py-1 text-xs text-neutral-700 hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {resetting === key ? "Resetting…" : "Reset"}
                </button>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label={`${WINDOW_LABELS[key]} used`}>
                <div className={capped ? "h-full bg-red-600" : "h-full bg-neutral-800"} style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                {window.resetsInMs > 0 ? `Resets in ${formatDurationMs(window.resetsInMs)}` : "Not started. Starts on the next request."}
                {capped && <span className="text-red-700"> · Limit reached</span>}
              </p>
            </div>
          );
        })}
      </div>
      {windows.pendingMicro > 0 && (
        <p className="mt-2 text-xs text-neutral-500">{formatUsdMicro(windows.pendingMicro)} reserved for in-flight requests counts toward both windows.</p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

function ProviderUsage() {
  const [open, setOpen] = useState(false);
  const [lumenUsage, setLumenUsage] = useState<LumenUsage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setLumenUsage(await getLumenUsage());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't load Lumen usage.");
    } finally {
      setLoading(false);
    }
  }

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
        dateStyle: "medium", timeStyle: "short",
      }).format(new Date(lumenUsage.last_used_at)) + (localTimeZoneLabel(lumenUsage.last_used_at) ? ` ${localTimeZoneLabel(lumenUsage.last_used_at)}` : "")],
  ];

  return (
    <details className="mb-6 rounded-xl border border-neutral-200 p-4" onToggle={(event) => {
      const expanded = event.currentTarget.open;
      setOpen(expanded);
      if (expanded && !lumenUsage && !loading) void load();
    }}>
      <summary className="cursor-pointer text-sm font-medium">Lumen account usage</summary>
      {open && <div className="mt-4">
        <p className="mt-2 text-xs text-neutral-500">Reported by Lumen for the shared account. Includes activity outside this router.</p>
        {loading ? <p role="status" className="mt-3 text-sm text-neutral-500">Loading Lumen usage…</p> : error ? <p role="alert" className="mt-3 text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => void load()}>Retry</button></p> : usageFields && (
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {usageFields.map(([label, value]) => <div key={label}><dt className="text-xs text-neutral-500">{label}</dt><dd className="mt-2 break-words text-sm tabular-nums">{value}</dd></div>)}
          </dl>
        )}
      </div>}
    </details>
  );
}

function LimitsEditor({ userId, fiveHourMicro, weeklyMicro }: {
  userId: string;
  fiveHourMicro: number | null;
  weeklyMicro: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const effectiveFiveHour = fiveHourMicro ?? DEFAULT_FIVE_HOUR_LIMIT_MICRO;
  const effectiveWeekly = weeklyMicro ?? DEFAULT_WEEKLY_LIMIT_MICRO;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parse = (value: FormDataEntryValue | null): number | null | "invalid" => {
      if (typeof value !== "string" || value.trim() === "") return null;
      const dollars = Number.parseFloat(value);
      if (!Number.isFinite(dollars) || dollars < 0) return "invalid";
      return Math.round(dollars * 1_000_000);
    };
    const fiveHour = parse(form.get("fiveHour"));
    const weekly = parse(form.get("weekly"));
    if (fiveHour === "invalid" || weekly === "invalid") {
      setError("Enter valid dollar amounts.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await updateUserLimits({ data: { userId, fiveHourMicro: fiveHour, weeklyMicro: weekly } });
      await router.invalidate();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Couldn't save limits.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1">
        <span className="text-neutral-500">5h $</span>
        <input
          name="fiveHour"
          type="number"
          min="0"
          step="0.5"
          defaultValue={fiveHourMicro === null ? "" : fiveHourMicro / 1_000_000}
          placeholder={String(effectiveFiveHour / 1_000_000)}
          className="w-20 rounded border border-neutral-200 px-1.5 py-1 tabular-nums"
        />
      </label>
      <label className="flex items-center gap-1">
        <span className="text-neutral-500">week $</span>
        <input
          name="weekly"
          type="number"
          min="0"
          step="0.5"
          defaultValue={weeklyMicro === null ? "" : weeklyMicro / 1_000_000}
          placeholder={String(effectiveWeekly / 1_000_000)}
          className="w-20 rounded border border-neutral-200 px-1.5 py-1 tabular-nums"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="cursor-pointer rounded bg-neutral-800 px-2.5 py-1 text-white disabled:cursor-wait disabled:text-neutral-400"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {error && <span role="alert" className="text-red-700">{error}</span>}
      <span className="w-full text-neutral-400">Empty fields fall back to the club defaults.</span>
    </form>
  );
}
