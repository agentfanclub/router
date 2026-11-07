import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSession } from "../lib/session";
import { getTokenLeaderboard } from "../lib/admin";
import { formatTokens } from "../lib/format";
import { DataTable, TableBody, TableHead, Td, Th } from "../components/data-table";

export const Route = createFileRoute("/_dashboard/leaderboard")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    if (session.user.role !== "admin") throw redirect({ to: "/" });
  },
  loader: async () => getTokenLeaderboard({ data: { days: 0 } }).then(
    (leaderboard) => ({ leaderboard, error: null }),
    (error: unknown) => ({ leaderboard: null, error: error instanceof Error ? error.message : "Couldn't load the token leaderboard." }),
  ),
  component: Page,
});

const RANGES = [
  { days: 0, label: "All time" },
  { days: 30, label: "30 days" },
  { days: 7, label: "7 days" },
] as const;

function Page() {
  const initial = Route.useLoaderData();
  const [days, setDays] = useState<0 | 7 | 30>(0);
  const [result, setResult] = useState(initial);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (days === 0) {
      setResult(initial);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getTokenLeaderboard({ data: { days } }).then(
      (leaderboard) => { if (!cancelled) setResult({ leaderboard, error: null }); },
      (error: unknown) => { if (!cancelled) setResult({ leaderboard: null, error: error instanceof Error ? error.message : "Couldn't load the token leaderboard." }); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, initial]);

  const leaderboard = result.leaderboard;
  const maxTokens = leaderboard?.entries[0]?.totalTokens ?? 0;

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-medium">Token Leaderboard</h1>
        <div className="inline-flex rounded-lg bg-neutral-100 text-xs font-normal" role="group" aria-label="Leaderboard time range">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              aria-pressed={days === range.days}
              disabled={loading}
              onClick={() => setDays(range.days)}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 transition-colors disabled:cursor-wait ${days === range.days ? "border-neutral-300 bg-white text-neutral-900 shadow-sm" : "border-transparent text-neutral-600 hover:text-neutral-900"}`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? <p role="status" className="mt-4 text-sm text-neutral-500">Loading leaderboard…</p> : leaderboard ? (
        <>
          <p className="mb-4 text-sm text-neutral-500">
            Total tokens used across all keys. Prompt tokens already include cached input, so they count once.
            {" "}{leaderboard.totals.totalTokens.toLocaleString("en-US")} tokens from {leaderboard.totals.users} {leaderboard.totals.users === 1 ? "person" : "people"}.
          </p>
          <DataTable variant="leaderboard" minWidth={720} caption="Users ranked by tokens used.">
            <TableHead>
              <Th align="right" pad="start">#</Th>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Tokens</Th>
              <Th align="right">Input</Th>
              <Th align="right" pad="end">Output</Th>
            </TableHead>
            <TableBody
              rows={leaderboard.entries}
              rowKey={(entry) => entry.userId}
              columns={6}
              empty="No token usage in this range yet."
              renderRow={(entry, index) => (
                <>
                  <Td align="right" pad="start" className="tabular-nums text-neutral-400">{index + 1}</Td>
                  <Td className="truncate text-neutral-800" title={entry.name || entry.email}>{entry.name || "—"}</Td>
                  <Td className="truncate" title={entry.email}>{entry.email}</Td>
                  <Td className="tabular-nums">
                    <span className="font-medium text-neutral-800" title={`${entry.totalTokens.toLocaleString("en-US")} tokens`}>{formatTokens(entry.totalTokens)}</span>
                    <span className="mt-1 block h-1 overflow-hidden rounded-[2px] bg-neutral-200" aria-hidden="true">
                      <span className="block h-full rounded-[2px] bg-neutral-700" style={{ width: `${maxTokens > 0 ? Math.max(entry.totalTokens / maxTokens * 100, 1) : 0}%` }} />
                    </span>
                    <span className="mt-1 block whitespace-nowrap text-xs text-neutral-400">{entry.requests.toLocaleString("en-US")} {entry.requests === 1 ? "request" : "requests"} · {entry.sessions.toLocaleString("en-US")} {entry.sessions === 1 ? "session" : "sessions"}</span>
                  </Td>
                  <Td align="right" className="whitespace-nowrap tabular-nums" title={`${entry.inputTokens.toLocaleString("en-US")} input tokens`}>{formatTokens(entry.inputTokens)}</Td>
                  <Td align="right" pad="end" className="whitespace-nowrap tabular-nums" title={`${entry.outputTokens.toLocaleString("en-US")} output tokens`}>{formatTokens(entry.outputTokens)}</Td>
                </>
              )}
            />
          </DataTable>
        </>
      ) : (
        <p role="alert" className="mt-4 text-sm text-red-700">{result.error} Reload the page to try again.</p>
      )}
    </section>
  );
}
