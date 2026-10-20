import { createFileRoute } from "@tanstack/react-router";
import { Brain, Check, Copy, Image, Minus, Terminal, Type } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useEffect, useState } from "react";

const features = {
  reasoning: { label: "Reasoning", icon: Brain },
  vision: { label: "Image input", icon: Image },
  tools: { label: "Tool use", icon: Terminal },
  text: { label: "Text", icon: Type },
};

// Sample catalog from the reference until a model API is connected.
const models = [
  { name: "Beam", id: "beam-free", features: ["reasoning", "tools", "text"], input: 0, output: 0, cacheRead: 0, cacheWrite: null },
  { name: "Big Pickle", id: "big-pickle", features: ["reasoning", "tools", "text"], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { name: "Claude Fable 5", id: "claude-fable-5", features: ["reasoning", "vision"], input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { name: "Claude Fable 5.1", id: "claude-fable-5-1", features: ["reasoning", "vision"], input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { name: "Claude Haiku 4.5", id: "claude-haiku-4-5", features: ["reasoning", "vision"], input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { name: "Claude Haiku 5.5", id: "claude-haiku-5-5", features: ["reasoning", "vision"], input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.13 },
  { name: "Claude Opus 4.5", id: "claude-opus-4-5", features: ["reasoning", "vision"], input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { name: "Claude Opus 4.6", id: "claude-opus-4-6", features: ["reasoning", "vision"], input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
] satisfies { name: string; id: string; features: (keyof typeof features)[]; input: number; output: number; cacheRead: number | null; cacheWrite: number | null }[];

const priceFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const Route = createFileRoute("/_dashboard/models")({
  component: Page,
});

function Page() {
  const [copyResult, setCopyResult] = useState<{ id: string; status: "copied" | "error" } | null>(null);

  useEffect(() => {
    if (!copyResult) return;
    const timeout = window.setTimeout(() => setCopyResult(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyResult]);

  return (
    <Tooltip.Provider delayDuration={200}>
      <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
        <p role="status" className="sr-only">
          {copyResult && (copyResult.status === "copied" ? `Copied ${copyResult.id} to clipboard.` : "Couldn't copy. Please try again.")}
        </p>
        <div className="mb-6">
          <h1 className="text-lg font-medium">Models</h1>
          <p className="mt-1 text-sm text-neutral-500">Prices in USD per million tokens.</p>
        </div>

        <div className="max-w-[960px] overflow-x-auto rounded-[14px] bg-[#eeeeee] p-[2px]">
          <table className="dashboard-table models-table w-full min-w-[872px] border-separate border-spacing-0 text-left text-sm text-neutral-600">
            <caption className="sr-only">Sample models with their IDs, features, and prices in USD per million tokens.</caption>
            <thead>
              <tr className="text-sm text-neutral-500">
                <th scope="col" className="px-6 py-2.5 font-medium">Model</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Features</th>
                {["Input", "Output", "Cache Read", "Cache Write"].map((label) => (
                  <th key={label} scope="col" className="whitespace-nowrap px-4 py-2.5 text-right font-medium last:pr-6">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white">
              {models.map((model) => (
                <tr key={model.id}>
                  <td className="min-w-0 px-6 py-3">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-neutral-800" title={model.name}>{model.name}</span>
                      {model.input === 0 && model.output === 0 && (
                        <span className="rounded border border-neutral-200 bg-neutral-100 px-1.5 py-0.5 text-[10px] leading-none text-neutral-500">Free</span>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Copy model ID ${model.id}`}
                      title="Copy model ID"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(model.id);
                          setCopyResult({ id: model.id, status: "copied" });
                        } catch {
                          setCopyResult({ id: model.id, status: "error" });
                        }
                      }}
                      className="group mt-1 flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-xs text-neutral-400 hover:text-neutral-600 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2"
                    >
                      <code className="truncate font-mono">{model.id}</code>
                      {copyResult?.id === model.id && copyResult.status === "copied" ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-green-600">
                          <Check size={12} aria-hidden="true" /> Copied
                        </span>
                      ) : (
                        <Copy size={12} aria-hidden="true" className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none" />
                      )}
                    </button>
                    {copyResult?.id === model.id && copyResult.status === "error" && (
                      <span className="mt-1 block text-xs text-red-600">Couldn't copy. Try again.</span>
                    )}
                  </td>
                  <td className="flex items-center gap-1 px-3 py-3">
                    {model.features.map((feature) => {
                      const { label, icon: Icon } = features[feature];
                      return (
                        <Tooltip.Root key={feature}>
                          <Tooltip.Trigger asChild>
                            <button type="button" aria-label={label} className="inline-flex size-6 cursor-help items-center justify-center rounded-[5px] border border-neutral-200/70 bg-neutral-100 text-neutral-500 hover:bg-neutral-200/70 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2">
                              <Icon size={12} aria-hidden="true" />
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content side="top" sideOffset={6} className="z-50 rounded-md bg-neutral-800 px-2 py-1 text-xs text-white shadow-sm">
                              {label}
                              <Tooltip.Arrow className="fill-neutral-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      );
                    })}
                  </td>
                  {[model.input, model.output, model.cacheRead, model.cacheWrite].map((price, index) => (
                    <td key={index} className="px-4 py-3 text-right tabular-nums last:pr-6">
                      {price === null ? <span aria-label="Not available" className="inline-flex align-middle text-neutral-400"><Minus size={14} aria-hidden="true" /></span> : priceFormatter.format(price)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Tooltip.Provider>
  );
}
