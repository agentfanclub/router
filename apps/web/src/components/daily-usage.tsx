import { Info } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { formatTokens } from "../lib/format";

const modelColors: Record<string, string> = {
  "glm-5.3": "#ef8f36",
  "deepseek-v4.1-flash": "#dd72f8",
  "qwen3.8-flash": "#a185f7",
  "deepseek-v4-flash": "#00bc7d",
};

export function modelColor(model: string): string {
  return modelColors[model] ?? "#a185f7";
}

export function DailyUsage({ history, models, days, onDaysChange, unit = "tokens", onUnitChange, title = "Daily token usage", description, tzOffset = 0 }: {
  history: { day: string; model: string; value: number }[];
  models: string[];
  days: number;
  onDaysChange: (days: number) => void;
  unit?: "tokens" | "coins";
  onUnitChange?: (unit: "tokens" | "coins") => void;
  title?: string;
  description?: string;
  // Viewer's UTC offset in minutes east, matching the API's day bucketing.
  tzOffset?: number;
}) {
  const headingId = useId();
  const tooltipId = useId();
  const formatValue = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: unit === "coins" ? 6 : 0 });
  const plotRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ dayIndex: number; modelIndex: number; x: number; y: number } | null>(null);

  function showTooltip({ dayIndex, modelIndex, clientX, clientY }: { dayIndex: number; modelIndex: number; clientX: number; clientY: number }) {
    const plot = plotRef.current;
    if (!plot) return;
    const bounds = plot.getBoundingClientRect();
    const x = Math.max(8, Math.min(clientX - bounds.left + 16, bounds.width - 192));
    const above = clientY - bounds.top - 88;
    const y = Math.max(8, Math.min(above >= 8 ? above : clientY - bounds.top + 16, bounds.height - 88));
    setTooltip({ dayIndex, modelIndex, x, y });
  }
  const { data, scaleMax, ticks } = useMemo(() => {
    // Lay out the axis on the viewer's calendar using the same offset the API
    // bucketed with, so server and client renders agree and the labels match
    // the tooltips. Shifting the epoch by the offset and reading UTC fields
    // gives the local calendar date without depending on the host clock zone.
    const offsetMs = tzOffset * 60_000;
    const localToday = Math.floor((Date.now() + offsetMs) / 86_400_000) * 86_400_000;
    const data = Array.from({ length: days }, (_, index) => {
      const dayMs = localToday - (days - 1 - index) * 86_400_000;
      const day = new Date(dayMs).toISOString().slice(0, 10);
      return {
        day,
        label: new Date(dayMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        counts: models.map(() => 0),
        total: 0,
      };
    });
    const byDay = new Map(data.map((row) => [row.day, row]));
    for (const row of history) {
      const point = byDay.get(row.day);
      if (point) {
        point.counts[models.indexOf(row.model)] += row.value;
        point.total += row.value;
      }
    }
    const minStep = unit === "coins" ? 0.000001 : 1;
    const max = Math.max(minStep, ...data.map((row) => row.total));
    const roughStep = Math.max(minStep, max / 4);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const step = ([1, 2, 2.5, 5, 10].find((size) => size * magnitude >= roughStep) ?? 10) * magnitude;
    const scaleMax = Math.ceil(max / step) * step;
    const ticks = Array.from({ length: Math.round(scaleMax / step) + 1 }, (_, index) => index * step);
    return { data, scaleMax, ticks };
  }, [history, days, models, unit, tzOffset]);

  return (
    <section className="mt-9" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-base font-medium">{title}</h2>
          {description && <p className="mt-1 text-sm text-neutral-500">{description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {onUnitChange && (
            <div className="inline-flex rounded-lg bg-neutral-100 text-xs font-normal" role="group" aria-label="Chart metric">
              {([['coins', 'Cost'], ['tokens', 'Tokens']] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={unit === value} onClick={() => { onUnitChange(value); setTooltip(null); }} className={`cursor-pointer rounded-lg border px-3 py-1.5 transition-colors ${unit === value ? "border-neutral-300 bg-white text-neutral-900 shadow-sm" : "border-transparent text-neutral-600 hover:text-neutral-900"}`}>{label}</button>
              ))}
            </div>
          )}
          <div className="inline-flex rounded-lg bg-neutral-100 text-xs font-normal" role="group" aria-label="Chart time range">
            {[7, 30].map((range) => <button key={range} type="button" aria-pressed={days === range} onClick={() => { onDaysChange(range); setTooltip(null); }} className={`cursor-pointer rounded-lg border px-3 py-1.5 transition-colors ${days === range ? "border-neutral-300 bg-white text-neutral-900 shadow-sm" : "border-transparent text-neutral-600 hover:text-neutral-900"}`}>{range} days</button>)}
          </div>
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-neutral-200 px-3 pb-5 pt-8 sm:px-5">
        {models.length > 0 ? (
          <>
            <div className="flex gap-3">
              <div aria-hidden="true" className="relative h-56 w-10 shrink-0 text-right text-[11px] text-neutral-500 sm:h-64">
                {ticks.map((tick) => <span key={tick} className="absolute right-0 translate-y-1/2 tabular-nums" style={{ bottom: `${tick / scaleMax * 100}%` }}>{unit === "coins" ? tick.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 6 }) : formatTokens(tick)}</span>)}
              </div>
              <div className="min-w-0 flex-1">
                <div ref={plotRef} className="relative h-56 sm:h-64" onPointerLeave={() => setTooltip(null)} onKeyDown={(event) => { if (event.key === "Escape") setTooltip(null); }}>
                  <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-50" style={{ backgroundImage: "radial-gradient(circle, #c4c4c4 0.7px, transparent 0.8px)", backgroundSize: "16px 16px", backgroundPosition: "8px 8px" }} />
                  <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                    {ticks.map((tick) => <div key={tick} className={`absolute inset-x-0 border-t ${tick === 0 ? "border-neutral-200" : "border-dashed border-neutral-200/60"}`} style={{ bottom: `${tick / scaleMax * 100}%` }} />)}
                  </div>
                  <div className="relative flex h-full items-end gap-1 sm:gap-2">
                    {data.map((point, dayIndex) => (
                      <div key={point.day} className="group flex h-full min-w-0 flex-1 items-end">
                        <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-[2px]" style={{ height: `${point.total / scaleMax * 100}%` }}>
                          {point.counts.map((count, modelIndex) => count > 0 && (
                            <div key={models[modelIndex]} tabIndex={0}
                              className="shrink-0 border-t-2 border-white last:border-t-0 focus-visible:brightness-110"
                              style={{ height: `${count / point.total * 100}%`, background: modelColor(models[modelIndex]) }}
                              aria-label={`${models[modelIndex]} · ${point.label}: ${formatValue(count)} ${unit}`}
                              aria-describedby={tooltip?.dayIndex === dayIndex && tooltip.modelIndex === modelIndex ? tooltipId : undefined}
                              onPointerEnter={(event) => showTooltip({ dayIndex, modelIndex, clientX: event.clientX, clientY: event.clientY })}
                              onPointerMove={(event) => showTooltip({ dayIndex, modelIndex, clientX: event.clientX, clientY: event.clientY })}
                              onPointerLeave={() => setTooltip(null)}
                              onFocus={(event) => {
                                const bounds = event.currentTarget.getBoundingClientRect();
                                showTooltip({ dayIndex, modelIndex, clientX: bounds.left + bounds.width / 2, clientY: bounds.top });
                              }}
                              onBlur={() => setTooltip(null)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {tooltip && (
                    <div id={tooltipId} role="tooltip" className="pointer-events-none absolute z-10 w-46 max-w-[calc(100%-16px)] rounded-md border border-white/10 bg-neutral-800 p-2.5 text-white shadow-[0_4px_16px_rgb(0_0_0/0.18)]" style={{ left: tooltip.x, top: tooltip.y }}>
                      <p className="text-[11px] text-neutral-400">{data[tooltip.dayIndex].label}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-sm" style={{ background: modelColor(models[tooltip.modelIndex]) }} />
                        <span className="break-all text-xs">{models[tooltip.modelIndex]}</span>
                      </div>
                      <p className="mt-1 text-sm font-medium leading-5 tabular-nums">{formatValue(data[tooltip.dayIndex].counts[tooltip.modelIndex])} <span className="text-xs font-normal text-neutral-400">{unit}</span></p>
                    </div>
                  )}
                </div>
                <div aria-hidden="true" className="mt-3 grid gap-1 text-[11px] text-neutral-500 sm:gap-2" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
                  {data.map((point, index) => <span key={point.day} className="relative h-4"><span className={`absolute whitespace-nowrap ${index === 0 ? "left-0" : index === days - 1 ? "right-0" : "left-1/2 -translate-x-1/2"}`}>{[0, Math.round((days - 1) / 3), Math.round((days - 1) * 2 / 3), days - 1].includes(index) ? point.label : ""}</span></span>)}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-[240px] flex-col items-center justify-center text-center">
            <Info size={20} strokeWidth={1.5} className="text-neutral-400" aria-hidden="true" />
            <h3 className="mt-4 text-sm font-normal text-neutral-500">No model usage yet</h3>
          </div>
        )}
      </div>
    </section>
  );
}
