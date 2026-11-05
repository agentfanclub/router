import { createFileRoute, Link } from "@tanstack/react-router";
import { getUsageSessions } from "../lib/usage";
import type { UsageLogRow } from "../../../api/src/routes/usage";
import { formatDateTime, formatSeconds, formatTokens, formatUsdMicro, localTimeZoneLabel } from "../lib/format";

interface LogsSearch {
  model?: string;
  page?: number;
}

export const Route = createFileRoute("/_dashboard/logs")({
  validateSearch: (search: Record<string, unknown>): LogsSearch => ({
    model: typeof search.model === "string" ? search.model : undefined,
    page: Number.isInteger(Number(search.page)) && Number(search.page) > 0 ? Number(search.page) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getUsageSessions({ data: { model: deps.model, page: deps.page } }),
  component: Page,
});

const statusStyles: Record<UsageLogRow["status"], string> = {
  pending: "text-neutral-500 bg-neutral-100 border-neutral-200",
  ok: "text-emerald-700 bg-emerald-50 border-emerald-200",
  error: "text-red-700 bg-red-50 border-red-200",
  aborted: "text-neutral-500 bg-neutral-100 border-neutral-200",
  denied: "text-amber-700 bg-amber-50 border-amber-200",
};

function Page() {
  const { sessions, hasMore } = Route.useLoaderData();
  const { model, page = 0 } = Route.useSearch();
  const timeZone = localTimeZoneLabel();

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
      <div className="mb-6">
        <h1 className="text-lg font-medium">Logs</h1>
        <p className="mt-1 text-sm text-neutral-500">Your conversations, grouped by session.</p>
        {model && <div className="mt-4 flex items-center gap-2 text-sm text-neutral-500">Model: {model}<Link to="/logs" search={{}} className="underline underline-offset-2">Clear filter</Link></div>}
      </div>
      <div className="dashboard-table-frame max-w-[960px] overflow-x-auto bg-[#eeeeee]">
        <table className="dashboard-table logs-table w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm text-neutral-600">
          <caption className="sr-only">Sessions ordered by their most recent request.</caption>
          <thead>
            <tr className="text-neutral-500">
              <th scope="col" className="px-4 py-2.5 font-medium">Time{timeZone ? ` (${timeZone})` : ""}</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Model</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Session</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Tokens</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Cost</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody className="bg-white" data-single-row={sessions.length === 1 ? "true" : undefined}>
            {sessions.map((item) => (
              <tr key={item.id}>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatDateTime(item.lastAt)}</td>
                <td className="min-w-0 px-3 py-3">
                  <span className="block truncate text-neutral-800" title={item.models.split(",").join(", ")}>{item.models.split(",").join(", ")}</span>
                </td>
                <td className="px-3 py-3">
                  <span className="font-mono text-xs text-neutral-700" title={item.sessionId ?? item.id}>
                    {item.sessionId ? shortenSession(item.sessionId) : "Ungrouped request"}
                  </span>
                  <span className="mt-1 block text-xs text-neutral-400">{item.requests} {item.requests === 1 ? "request" : "requests"}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                  {formatTokens(item.inputTokens)} → {formatTokens(item.outputTokens)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">{item.estimated && item.costMicro > 0 ? "≈ " : ""}{formatUsdMicro(item.costMicro)}</td>
                <td className="px-3 py-3">
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${statusStyles[item.pending > 0 ? "pending" : item.errors > 0 ? "error" : "ok"]}`} title={item.errors > 0 ? `${item.errors} unsuccessful requests` : undefined}>
                    {item.pending > 0 ? "pending" : item.errors > 0 ? "error" : "ok"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums" title="Total time across requests">{formatSeconds(item.durationMs)}</td>
              </tr>
            ))}
            {sessions.length === 0 && <tr><td colSpan={7} className="col-span-full px-6 py-10 text-center text-neutral-500">{model ? "No sessions for this model." : "No sessions yet. Your requests will appear here."}</td></tr>}
          </tbody>
        </table>
      </div>
      {(page > 0 || hasMore) && <div className="mt-4 flex justify-between text-sm">
        {page > 0 ? <Link to="/logs" search={{ model, page: page > 1 ? page - 1 : undefined }}>← Newer sessions</Link> : <span />}
        {hasMore && <Link to="/logs" search={{ model, page: page + 1 }}>Older sessions →</Link>}
      </div>}
    </section>
  );
}

function shortenSession(id: string) {
  return id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}
