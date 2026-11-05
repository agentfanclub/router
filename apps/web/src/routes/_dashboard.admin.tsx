import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { DailyUsage } from "../components/daily-usage";
import { useEffect, useState } from "react";
import { getSession } from "../lib/session";
import { getLumenUsage, listUsers } from "../lib/admin";
import { getAdminUsage, updateUserLimits } from "../lib/usage";
import { formatUsdMicro, localTimeZoneLabel } from "../lib/format";

export const DEFAULT_FIVE_HOUR_LIMIT_MICRO = 10_000_000;
export const DEFAULT_WEEKLY_LIMIT_MICRO = 50_000_000;

export const Route = createFileRoute("/_dashboard/admin")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    if (session.user.role !== "admin") throw redirect({ to: "/" });
  },
  loader: async () => {
    const [users, lumenUsage, adminUsage] = await Promise.all([
      listUsers(),
      getLumenUsage().then(
        (usage) => ({ usage, error: null }),
        (error: unknown) => ({ usage: null, error: error instanceof Error ? error.message : "Couldn't load Lumen usage." }),
      ),
      getAdminUsage({ data: { days: 30 } }).then(
        (usage) => ({ usage, error: null }),
        (error: unknown) => ({ usage: null, error: error instanceof Error ? error.message : "Couldn't load usage logs." }),
      ),
    ]);
    return { users, lumenUsage, adminUsage };
  },
  component: Page,
});

function Page() {
  const { users, lumenUsage: lumenResult, adminUsage } = Route.useLoaderData();
  const [days, setDays] = useState(30);
  const [unit, setUnit] = useState<"coins" | "tokens">("coins");
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
        dateStyle: "medium", timeStyle: "short",
      }).format(new Date(lumenUsage.last_used_at)) + (localTimeZoneLabel(lumenUsage.last_used_at) ? ` ${localTimeZoneLabel(lumenUsage.last_used_at)}` : "")],
  ];

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">

      <h1 className="mb-6 text-lg font-medium">Admin Panel</h1>

      <section className="mb-6" aria-labelledby="lumen-usage-heading">
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

      <section className="mb-6" aria-label="Router usage">
        {loading ? <p role="status" className="mt-4 text-sm text-neutral-500">Loading usage…</p> : adminResult.usage ? (
          <>
            <DailyUsage
              history={adminResult.usage.history.map((row) => ({ day: row.day, model: row.model, value: unit === "coins" ? row.costMicro / 1_000_000 : row.tokens }))}
              models={[...new Set(adminResult.usage.history.map((row) => row.model))]}
              days={days}
              onDaysChange={setDays}
              unit={unit}
              onUnitChange={setUnit}
              tzOffset={adminResult.usage.tzOffset}
              title={unit === "coins" ? "Daily cost in coins" : "Daily token usage"}
              description="Total usage across all users, including club and personal keys"
            />
            <div className="dashboard-table-frame mt-6 overflow-x-auto bg-[#eeeeee]">
              <table className="dashboard-table users-table w-full min-w-[720px] border-separate border-spacing-0 text-left text-sm text-neutral-600">
                <caption className="sr-only">Users with their roles, spend, and usage limits.</caption>
                <thead>
                  <tr className="text-neutral-500">
                    <th scope="col" className="px-5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Email</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Role</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Spend</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Limits (5h / week)</th>
                  </tr>
                </thead>
                <tbody className="bg-white" data-single-row={users.length === 1 ? "true" : undefined}>
                  {users.map((user) => {
                    const spend = adminResult.usage!.perUser.find((row) => row.userId === user.id);
                    return (
                      <tr key={user.id}>
                        <td className="truncate px-5 py-3 text-neutral-800" title={user.name}>{user.name || "—"}</td>
                        <td className="truncate px-3 py-3" title={user.email}>{user.email}</td>
                        <td className="px-3 py-3">
                          <span className="rounded border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs">{user.role}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                          {spend
                            ? <>
                                <span className="text-neutral-800">{formatUsdMicro(spend.clubMicro)}</span>
                                {spend.personalMicro > 0 && (
                                  <span className="text-neutral-400" title="Spend on the user's personal Lumen key">
                                    {" "}+ {formatUsdMicro(spend.personalMicro)} personal
                                  </span>
                                )}
                                <span className="block text-xs text-neutral-400">{spend.sessions.toLocaleString("en-US")} {spend.sessions === 1 ? "session" : "sessions"}</span>
                              </>
                            : "—"}
                        </td>
                        <td className="px-5 py-3">
                          <LimitsEditor
                            userId={user.id}
                            fiveHourMicro={user.fiveHourMicro}
                            weeklyMicro={user.weeklyMicro}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={5} className="col-span-full px-6 py-8 text-center text-neutral-500">No users yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {adminResult.usage.perModel.length > 0 && (
              <div className="dashboard-table-frame mt-6 overflow-x-auto bg-[#eeeeee]">
                <table className="dashboard-table models-usage-table w-full min-w-[560px] border-separate border-spacing-0 text-left text-sm text-neutral-600">
                  <caption className="sr-only">Spend per model over the selected range.</caption>
                  <thead>
                    <tr className="text-neutral-500">
                      <th scope="col" className="px-5 py-2.5 font-medium">Model</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Requests</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Input tokens</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Output tokens</th>
                      <th scope="col" className="px-5 py-2.5 font-medium">Spend</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white" data-single-row={adminResult.usage.perModel.length === 1 ? "true" : undefined}>
                    {adminResult.usage.perModel.map((row) => (
                      <tr key={row.model}>
                        <td className="truncate px-5 py-3 text-neutral-800" title={row.model}>{row.model}</td>
                        <td className="px-3 py-3 tabular-nums">{row.requests.toLocaleString("en-US")}</td>
                        <td className="px-3 py-3 tabular-nums">{row.inputTokens.toLocaleString("en-US")}</td>
                        <td className="px-3 py-3 tabular-nums">{row.outputTokens.toLocaleString("en-US")}</td>
                        <td className="whitespace-nowrap px-5 py-3 tabular-nums">{formatUsdMicro(row.costMicro)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p role="alert" className="mt-4 text-sm text-red-700">{adminResult.error} Reload the page to try again.</p>
        )}
      </section>
    </section>
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
      (event.target as HTMLFormElement).closest("details")?.removeAttribute("open");
      await router.invalidate();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Couldn't save limits.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs tabular-nums text-neutral-700 hover:border-neutral-400">
        {formatUsdMicro(effectiveFiveHour)} / {formatUsdMicro(effectiveWeekly)}
        <span className="text-neutral-400 group-open:hidden">edit</span>
      </summary>
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
    </details>
  );
}
