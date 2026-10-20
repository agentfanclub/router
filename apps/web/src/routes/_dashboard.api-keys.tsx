import { createFileRoute } from "@tanstack/react-router";
import { Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";

// Sample data for the UI until API key management is connected.
const sampleKeys = [
  { id: "production", name: "Production", token: "sk-router-••••••••••••7f2a", createdAt: "2026-10-16", enabled: true },
  { id: "development", name: "Development", token: "sk-router-••••••••••••9c4b", createdAt: "2026-10-14", enabled: true },
  { id: "playground", name: "Playground", token: "sk-router-••••••••••••3e8d", createdAt: "2026-10-12", enabled: false },
  { id: "local", name: "Local testing", token: "sk-router-••••••••••••6a1f", createdAt: "2026-10-10", enabled: true },
];

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export const Route = createFileRoute("/_dashboard/api-keys")({
  component: Page,
});

function Page() {
  const [keys, setKeys] = useState(sampleKeys);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  return (
    <section className="mx-auto w-full max-w-[1008px] px-6 pb-6 pt-10 max-[480px]:px-4">
      <Dialog open={creating} onOpenChange={(open) => { setCreating(open); if (!open) setName(""); }}>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div>
            <h1 className="text-lg font-medium">API Keys</h1>
            <p className="mt-1 text-sm text-neutral-500">Manage the keys your apps use to access Router.</p>
          </div>
          <DialogTrigger asChild>
            <Button>
              <Plus size={13} aria-hidden="true" />
              Create new API Key
            </Button>
          </DialogTrigger>
        </div>

        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader className="text-left">
            <DialogTitle className="font-medium">Create API key</DialogTitle>
            <DialogDescription>Give your key a name to identify where it's used.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              const keyName = name.trim();
              if (!keyName) return;
              const id = crypto.randomUUID();
              setKeys((current) => [...current, {
                id,
                name: keyName,
                token: `sk-router-••••••••••••${id.slice(0, 4)}`,
                createdAt: new Date().toISOString().slice(0, 10),
                enabled: true,
              }]);
              setName("");
              setCreating(false);
            }}
          >
            <div className="flex flex-col gap-2">
              <label htmlFor="api-key-name" className="text-xs font-medium">Key name</label>
              <input
                id="api-key-name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Production"
                className="h-9 rounded-[5px] border border-neutral-300 bg-white px-2.5 text-[13px] outline-none placeholder:text-neutral-400 focus-visible:border-neutral-500 "
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <button
                  type="button"
                  className="min-h-8 cursor-pointer rounded-[7px] border border-neutral-200 bg-white px-3 text-xs text-neutral-600 hover:bg-neutral-50 "
                >
                  Cancel
                </button>
              </DialogClose>
              <Button type="submit" disabled={!name.trim()}>Create key</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="max-w-[960px] overflow-x-auto rounded-[14px] bg-[#eeeeee] p-[2px]">
        <table className="dashboard-table api-keys-table w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm text-neutral-600">
          <caption className="sr-only">API keys with their name, masked token, creation date, and enabled status.</caption>
          <thead>
            <tr className="text-sm text-neutral-500">
              <th scope="col" className="px-6 py-2.5 font-medium">Name</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Token</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Created at</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Enabled</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="bg-white" data-single-row={keys.length === 1}>
            {keys.map((key) => (
              <tr key={key.id} className={key.enabled ? undefined : "[&>td:nth-child(-n+3)]:opacity-50"}>
                <td className="flex h-10 min-w-0 items-center px-6">
                  <span className="block truncate" title={key.name}>{key.name}</span>
                </td>
                <td className="flex h-10 items-center px-5">
                  <code className="whitespace-nowrap rounded-[5px] border border-neutral-200/70 bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-500">{key.token}</code>
                </td>
                <td className="flex h-10 items-center whitespace-nowrap px-5 text-neutral-500">
                  <time dateTime={key.createdAt}>{dateFormatter.format(new Date(key.createdAt))}</time>
                </td>
                <td className="flex h-10 items-center justify-end px-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={key.enabled}
                    aria-label={`Enable ${key.name}`}
                    onClick={() => setKeys((current) => current.map((item) => item.id === key.id ? { ...item, enabled: !item.enabled } : item))}
                    className={`inline-flex h-6 w-11 cursor-pointer items-center rounded-full border p-[3px] align-middle shadow-inner transition-colors motion-reduce:transition-none ${key.enabled ? "border-green-600 bg-green-600 hover:bg-green-700" : "border-neutral-300 bg-neutral-200 hover:bg-neutral-300"}`}
                  >
                    <span aria-hidden="true" className={`flex size-4 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0_/_20%)] transition-transform motion-reduce:transition-none ${key.enabled ? "translate-x-5" : "translate-x-0"}`}>
                      {key.enabled && <Check size={10} strokeWidth={3} className="text-green-600" />}
                    </span>
                  </button>
                </td>
                <td className="flex h-10 items-center justify-end pl-1 pr-3">
                  <Dialog>
                    <DialogTrigger asChild>
                      <button type="button" aria-label={`Delete ${key.name}`} title="Delete key" className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[420px]">
                      <DialogHeader className="text-left">
                        <DialogTitle className="font-medium">Delete API key?</DialogTitle>
                        <DialogDescription>
                          The key &quot;{key.name}&quot; will be removed. This cannot be undone.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <button type="button" className="min-h-8 cursor-pointer rounded-[7px] border border-neutral-200 bg-white px-3 text-xs text-neutral-600 hover:bg-neutral-50">Cancel</button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button variant="destructive" onClick={() => setKeys((current) => current.filter((item) => item.id !== key.id))}>Delete key</Button>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="col-span-full px-6 py-8 text-center text-neutral-500">
                  <p className="mb-4">No API keys yet.</p>
                  <Button onClick={() => setCreating(true)}>
                    <Plus size={13} aria-hidden="true" />
                    Create new API Key
                  </Button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
