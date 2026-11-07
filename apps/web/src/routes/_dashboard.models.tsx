import { createFileRoute } from "@tanstack/react-router";
import { Brain, Check, Copy, Image, Minus, Terminal, Type } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useEffect, useState } from "react";
import { listModels } from "../lib/models";
import { DataTable, TableBody, TableHead, Td, Th } from "../components/data-table";

const features = {
  reasoning: { label: "Reasoning", icon: Brain },
  vision: { label: "Image input", icon: Image },
  tools: { label: "Tool use", icon: Terminal },
  text: { label: "Text", icon: Type },
};

const priceFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const Route = createFileRoute("/_dashboard/models")({
  loader: () => listModels(),
  component: Page,
});

function Page() {
  const models = Route.useLoaderData();
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

        <DataTable variant="models" minWidth={872} caption="Models with their IDs, features, and prices in USD per million tokens.">
          <TableHead>
            <Th pad="start" className="px-6">Model</Th>
            <Th>Features</Th>
            {["Input", "Output", "Cache Read", "Cache Write"].map((label) => (
              <Th key={label} align="right" className="whitespace-nowrap px-4 last:pr-6">{label}</Th>
            ))}
          </TableHead>
          <TableBody
            rows={models}
            rowKey={(model) => model.id}
            columns={6}
            empty="No models available."
            renderRow={(model) => (
              <>
                <Td pad="start" className="min-w-0 px-6">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-neutral-800" title={model.name}>{model.name}</span>
                    {model.cost.input === 0 && model.cost.output === 0 && (
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
                </Td>
                <Td className="flex items-center gap-1">
                  {(Object.keys(features) as (keyof typeof features)[]).filter((feature) => {
                    switch (feature) {
                      case "reasoning": return model.reasoning;
                      case "vision": return model.modalities.input.includes("image");
                      case "tools": return model.tool_call;
                      case "text": return model.modalities.input.includes("text");
                    }
                  }).map((feature) => {
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
                </Td>
                {[model.cost.input, model.cost.output, model.cost.cache_read, model.cost.cache_write].map((price, index) => (
                  <Td key={index} align="right" className="px-4 tabular-nums last:pr-6">
                    {price == null ? <span aria-label="Not available" className="inline-flex align-middle text-neutral-400"><Minus size={14} aria-hidden="true" /></span> : priceFormatter.format(price)}
                  </Td>
                ))}
              </>
            )}
          />
        </DataTable>
      </section>
    </Tooltip.Provider>
  );
}
