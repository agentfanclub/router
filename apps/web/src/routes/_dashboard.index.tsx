import { createFileRoute } from "@tanstack/react-router";
import { DailyUsage, modelColor } from "../components/daily-usage";
import { Info } from "lucide-react";
import { useRef, useState } from "react";
import type { UsageStatus } from "../../../api/src/routes/usage";
import { getMyUsage } from "../lib/usage";
import { formatDurationMs, formatTokens, formatUsdMicro } from "../lib/format";

export const Route = createFileRoute("/_dashboard/")({
  loader: async () => getMyUsage().then(
    (usage) => ({ usage, error: null }),
    (error: unknown) => ({ usage: null, error: error instanceof Error ? error.message : "Couldn't load usage." }),
  ),
  component: Page,
});

function Page() {
  const { usage, error } = Route.useLoaderData();
  const [days, setDays] = useState(30);
  const [mixDays, setMixDays] = useState(30);
  const mixRef = useRef<HTMLDivElement>(null);
  const [mixTooltip, setMixTooltip] = useState<{ model: string; metric: "share" | "costShare"; x: number; y: number } | null>(null);
  const modelNames = [...new Set([...(usage?.perModel.map((model) => model.model) ?? []), ...(usage?.history.map((row) => row.model) ?? [])])];
  const modelTotals = usage?.perModel.map((model) => ({
    model: model.model,
    tokens: mixDays === 7 ? model.last7DaysTokens : model.inputTokens + model.outputTokens,
    costMicro: mixDays === 7 ? model.last7DaysChargeMicro : model.chargeMicro,
  })) ?? [];
  const modelTokenTotal = modelTotals.reduce((total, model) => total + model.tokens, 0);
  const modelCostTotal = modelTotals.reduce((total, model) => total + model.costMicro, 0);
  const modelMix = modelTotals.filter((model) => model.tokens > 0 || model.costMicro > 0).map((model) => ({
    ...model,
    share: modelTokenTotal > 0 ? model.tokens / modelTokenTotal * 100 : 0,
    costShare: modelCostTotal > 0 ? model.costMicro / modelCostTotal * 100 : 0,
    color: modelColor(model.model),
  }));
  const hoveredModel = modelMix.find((model) => model.model === mixTooltip?.model);

  function showMixTooltip(model: string, metric: "share" | "costShare", clientX: number, clientY: number) {
    const bounds = mixRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setMixTooltip({
      model,
      metric,
      x: Math.max(8, Math.min(clientX - bounds.left + 12, bounds.width - 192)),
      y: Math.max(8, clientY - bounds.top - 92),
    });
  }

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
      <h1 className="mb-6 text-lg font-medium">Overview</h1>
      {usage ? (
        <>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <section className="rounded-[14px] border border-neutral-200 bg-[#fafafa] px-6 py-4 shadow-[0_2px_4px_rgb(0_0_0/0.04)]" aria-labelledby="usage-limits-heading">
              <h2 id="usage-limits-heading" className="text-base font-medium">Usage limits</h2>
              <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-5 sm:grid-cols-[minmax(0,1fr)_minmax(64px,1.2fr)_auto]">
                <UsageMeter label="Five-hour" window={usage.fiveHour} />
                <UsageMeter label="Weekly" window={usage.weekly} />
              </div>
            </section>
            <section className="rounded-[14px] border border-neutral-200 bg-[#fafafa] px-6 py-4 shadow-[0_2px_4px_rgb(0_0_0/0.04)]" aria-labelledby="token-usage-heading">
              <h2 id="token-usage-heading" className="text-base font-medium">Token usage</h2>
              <dl className="mt-3 space-y-2">
                {([
                  ["Last 24 hours", usage.tokens.last24Hours],
                  ["Last 7 days", usage.tokens.last7Days],
                  ["Last 30 days", usage.tokens.last30Days],
                  ["Lifetime", usage.tokens.lifetime],
                ] as const).map(([label, count]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4">
                    <dt className="text-sm text-neutral-500">{label}</dt>
                    <dd className="text-base font-medium tabular-nums" title={`${count.toLocaleString("en-US")} tokens`}>
                      {formatTokens(count)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
          <DailyUsage history={usage.history.map((row) => ({ day: row.day, model: row.model, value: row.tokens }))} models={modelNames} days={days} onDaysChange={setDays} tzOffset={usage.tzOffset} />
          <section className="mt-9" aria-labelledby="model-usage-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="model-usage-heading" className="text-base font-medium">Model mix</h2>
              <div className="inline-flex rounded-lg bg-neutral-100 text-xs font-normal" role="group" aria-label="Model mix time range">
                {[7, 30].map((range) => <button key={range} type="button" aria-pressed={mixDays === range} onClick={() => { setMixDays(range); setMixTooltip(null); }} className={`cursor-pointer rounded-lg border px-3 py-1.5 transition-colors ${mixDays === range ? "border-neutral-300 bg-white text-neutral-900 shadow-sm" : "border-transparent text-neutral-600 hover:text-neutral-900"}`}>{range} days</button>)}
              </div>
            </div>
            {modelMix.length > 0 ? (
              <div ref={mixRef} className="relative mt-4 rounded-xl border border-neutral-200 p-5 sm:p-6" onPointerLeave={() => setMixTooltip(null)} onKeyDown={(event) => { if (event.key === "Escape") setMixTooltip(null); }}>
                <div className="space-y-5">
                  {([['Token share', 'share'], ['Cost share', 'costShare']] as const).map(([label, metric]) => (
                    <div key={metric}>
                      <div className="mb-2 flex items-baseline justify-between text-xs text-neutral-500">
                        <span>{label}</span>
                        {metric === 'costShare' && modelCostTotal === 0 && <span>No recorded cost</span>}
                      </div>
                      <div className="flex h-8 gap-0.5 overflow-hidden rounded" role="group" aria-label={label}>
                        {modelMix.filter((model) => model[metric] > 0).map((model) => (
                          <div
                            key={model.model}
                            tabIndex={0}
                            style={{ flexGrow: model[metric], background: model.color }}
                            className="h-full basis-0 focus-visible:brightness-110"
                            aria-label={`${model.model}: ${model[metric].toLocaleString('en-US', { maximumFractionDigits: 1 })}% ${label.toLowerCase()}`}
                            aria-describedby={mixTooltip?.model === model.model && mixTooltip.metric === metric ? "model-mix-tooltip" : undefined}
                            onPointerEnter={(event) => showMixTooltip(model.model, metric, event.clientX, event.clientY)}
                            onPointerMove={(event) => showMixTooltip(model.model, metric, event.clientX, event.clientY)}
                            onPointerLeave={() => setMixTooltip(null)}
                            onFocus={(event) => {
                              const bounds = event.currentTarget.getBoundingClientRect();
                              showMixTooltip(model.model, metric, bounds.left + bounds.width / 2, bounds.top);
                            }}
                            onBlur={() => setMixTooltip(null)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {mixTooltip && hoveredModel && (
                  <div id="model-mix-tooltip" role="tooltip" className="pointer-events-none absolute z-10 w-46 max-w-[calc(100%-16px)] rounded-md border border-white/10 bg-neutral-800 p-2.5 text-white shadow-[0_4px_16px_rgb(0_0_0/0.18)]" style={{ left: mixTooltip.x, top: mixTooltip.y }}>
                    <div className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-sm" style={{ background: hoveredModel.color }} />
                      <span className="break-all text-xs">{hoveredModel.model}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium leading-5 tabular-nums">{hoveredModel[mixTooltip.metric].toLocaleString("en-US", { maximumFractionDigits: 1 })}% <span className="text-xs font-normal text-neutral-400">of {mixTooltip.metric === "share" ? "tokens" : "cost"}</span></p>
                    <p className="mt-0.5 text-[11px] text-neutral-400">{mixTooltip.metric === "share" ? `${hoveredModel.tokens.toLocaleString("en-US")} tokens` : formatUsdMicro(hoveredModel.costMicro)}</p>
                  </div>
                )}
                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-neutral-500">
                  {modelMix.map((model) => (
                    <span key={model.model} className="inline-flex items-center gap-2">
                      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: model.color }} />
                      {model.model}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-4 flex min-h-[200px] flex-col items-center justify-center rounded-xl border border-neutral-200 px-6 py-8 text-center">
                <Info size={20} strokeWidth={1.5} className="text-neutral-400" aria-hidden="true" />
                <h3 className="mt-4 text-sm font-normal text-neutral-500">No model usage yet</h3>
              </div>
            )}
          </section>
        </>
      ) : <p role="alert" className="mt-6 text-sm text-red-700">{error} Reload the page to try again.</p>}
    </section>
  );
}

function UsageMeter({ label, window }: { label: string; window: UsageStatus["fiveHour"] }) {
  const percent = Math.max(0, window.usedPercent);
  const displayed = percent.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return (
    <div className="col-span-full grid grid-cols-subgrid items-center gap-x-4 gap-y-3">
      <div>
        <h3 className="text-sm">{label}</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          {window.resetsInMs > 0 ? `Resets in ${formatDurationMs(window.resetsInMs)}` : "Not started"}
        </p>
      </div>
      <div className="col-span-2 row-start-2 h-2 overflow-hidden rounded-[3px] border border-neutral-300 bg-neutral-200 sm:col-span-1 sm:col-start-2 sm:row-start-1" role="progressbar" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)} aria-valuetext={`${displayed}% used`}>
        <div className={`h-full rounded-sm ${percent >= 85 ? "bg-amber-500" : "bg-neutral-700"}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <p className="col-start-2 row-start-1 text-right text-sm tabular-nums sm:col-start-3">
        {displayed}% used
      </p>
    </div>
  );
}
