import { createFileRoute, Link } from "@tanstack/react-router";
import { getUsageSessions } from "../lib/usage";
import type { UsageLogRow } from "../../../api/src/routes/usage";
import { formatDateTime, formatSeconds, formatTokens, formatUsdMicro, localTimeZoneLabel } from "../lib/format";
import { DataTable, TableBody, TableHead, Td, Th } from "../components/data-table";

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
      <DataTable variant="logs" minWidth={760} caption="Sessions ordered by their most recent request.">
        <TableHead>
          <Th pad="start">Time{timeZone ? ` (${timeZone})` : ""}</Th>
          <Th>Model</Th>
          <Th>Session</Th>
          <Th>Tokens</Th>
          <Th>Cost</Th>
          <Th>Status</Th>
          <Th pad="end" className="px-4">Duration</Th>
        </TableHead>
        <TableBody
          rows={sessions}
          rowKey={(item) => item.id}
          columns={7}
          empty={model ? "No sessions for this model." : "No sessions yet. Your requests will appear here."}
          renderRow={(item) => (
            <>
              <Td pad="start" className="whitespace-nowrap tabular-nums">{formatDateTime(item.lastAt)}</Td>
              <Td className="min-w-0">
                <span className="block truncate text-neutral-800" title={item.models.split(",").join(", ")}>{item.models.split(",").join(", ")}</span>
              </Td>
              <Td>
                <span className="font-mono text-xs text-neutral-700" title={item.sessionId ?? item.id}>
                  {item.sessionId ? shortenSession(item.sessionId) : "Ungrouped request"}
                </span>
                <span className="mt-1 block text-xs text-neutral-400">{item.requests} {item.requests === 1 ? "request" : "requests"}</span>
              </Td>
              <Td className="whitespace-nowrap tabular-nums">
                {formatTokens(item.inputTokens)} → {formatTokens(item.outputTokens)}
              </Td>
              <Td className="whitespace-nowrap tabular-nums">{item.estimated && item.chargeMicro > 0 ? "≈ " : ""}{formatUsdMicro(item.chargeMicro)}</Td>
              <Td>
                <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${statusStyles[item.pending > 0 ? "pending" : item.errors > 0 ? "error" : "ok"]}`} title={item.errors > 0 ? `${item.errors} unsuccessful requests` : undefined}>
                  {item.pending > 0 ? "pending" : item.errors > 0 ? "error" : "ok"}
                </span>
              </Td>
              <Td pad="end" className="whitespace-nowrap px-4 tabular-nums" title="Total time across requests">{formatSeconds(item.durationMs)}</Td>
            </>
          )}
        />
      </DataTable>
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
