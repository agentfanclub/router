import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { addByokKey, deleteByokKey, listByokKeys } from "../lib/byok";
import { Button } from "./button";
import { DataTable, TableBody, TableHead, Td, Th } from "./data-table";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function PersonalLumenKeys({ initialKeys, loadError }: {
  initialKeys: Awaited<ReturnType<typeof listByokKeys>> | null;
  loadError: string | null;
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  return (
    <section className="mt-10 border-t border-neutral-200 dark:border-neutral-700 pt-8" aria-labelledby="personal-lumen-heading">
      <Dialog open={adding} onOpenChange={(open) => {
        if (saving) return;
        setAdding(open);
        if (!open) {
          setLabel("");
          setKey("");
          setAddError("");
        }
      }}>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="max-w-[640px]">
            <h2 id="personal-lumen-heading" className="text-base font-medium">Personal Lumen keys</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Use your own <a href="https://lumen.ncsa.illinois.edu" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-100">Lumen</a> key when you run out of usage. Usage is billed to your Lumen account.</p>
          </div>
          <DialogTrigger asChild>
            <Button disabled={keys === null}>
              <Plus size={13} aria-hidden="true" />
              Add Lumen key
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader className="text-left">
            <DialogTitle className="font-medium">Add Lumen key</DialogTitle>
            <DialogDescription>Paste a key from your Lumen account. We'll verify it before adding it.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-5" onSubmit={async (event) => {
            event.preventDefault();
            if (saving || !label.trim() || !key.trim()) return;
            setSaving(true);
            setAddError("");
            try {
              const created = await addByokKey({ data: { label: label.trim(), key: key.trim() } });
              setKeys((current) => [created, ...(current ?? [])]);
              setAdding(false);
              setLabel("");
              setKey("");
            } catch (error) {
              setAddError(error instanceof Error ? error.message : "Couldn't add the key. Try again.");
            } finally {
              setSaving(false);
            }
          }}>
            <div className="flex flex-col gap-2">
              <label htmlFor="lumen-key-name" className="text-xs font-medium">Key name</label>
              <input id="lumen-key-name" required disabled={saving} maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Personal Lumen"
                className="h-9 rounded-[5px] border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2.5 text-[13px] outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus-visible:border-neutral-500 dark:focus-visible:border-neutral-400" />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="lumen-key-token" className="text-xs font-medium">Lumen API key</label>
              <input id="lumen-key-token" type="password" autoComplete="off" spellCheck={false} required disabled={saving} maxLength={4096} value={key} onChange={(event) => setKey(event.target.value)} placeholder="sk_...."
                className="h-9 rounded-[5px] border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2.5 text-[13px] outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus-visible:border-neutral-500 dark:focus-visible:border-neutral-400" />
            </div>
            {addError && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{addError}</p>}
            <DialogFooter>
              <DialogClose asChild>
                <button type="button" disabled={saving} className="min-h-8 cursor-pointer rounded-[7px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-900">Cancel</button>
              </DialogClose>
              <Button type="submit" disabled={saving || !label.trim() || !key.trim()}>{saving ? "Verifying…" : "Add key"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {keys === null ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{loadError} Reload the page to try again.</p> : (
        <DataTable variant="api-keys" minWidth={760} caption="Personal Lumen keys with their name, masked token, creation date, and status.">
          <TableHead>
            <Th pad="start" className="px-6 font-normal">Name</Th>
            <Th className="px-5 font-normal">Token</Th>
            <Th className="px-5 font-normal">Created at</Th>
            <Th align="right" className="font-normal">Status</Th>
            <Th><span className="sr-only">Actions</span></Th>
          </TableHead>
          <TableBody
            rows={keys}
            rowKey={(item) => item.id}
            columns={5}
            empty="No personal Lumen keys added yet."
            renderRow={(item) => (
              <>
                <Td pad="start" className="flex h-10 min-w-0 items-center px-6"><span className="block truncate" title={item.label}>{item.label}</span></Td>
                <Td className="flex h-10 items-center px-5">
                  <code className="whitespace-nowrap rounded-[5px] border border-neutral-200/70 bg-neutral-100 dark:bg-neutral-800 px-2 py-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">••••••••••••{item.lastFive}</code>
                </Td>
                <Td className="flex h-10 items-center whitespace-nowrap px-5 text-neutral-500 dark:text-neutral-400">
                  <time dateTime={new Date(item.createdAt).toISOString()}>{dateFormatter.format(new Date(item.createdAt))}</time>
                </Td>
                <Td align="right" className="flex h-10 items-center justify-end gap-1.5 text-xs" title={item.status === "active" ? undefined : "Lumen rejected this key. Remove it and add a valid key."}>
                  <span aria-hidden="true" className={`size-1.5 rounded-full ${item.status === "active" ? "bg-green-600" : "bg-amber-500"}`} />
                  {item.status === "active" ? "Active" : "Invalid"}
                </Td>
                <Td align="right" pad="end" className="flex h-10 items-center justify-end pl-1 pr-3">
                    <Dialog open={deletingId === item.id} onOpenChange={(open) => {
                      if (deleting) return;
                      setDeletingId(open ? item.id : null);
                      setDeleteError("");
                    }}>
                      <DialogTrigger asChild>
                        <button type="button" aria-label={`Remove ${item.label}`} title="Remove key" className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400">
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </DialogTrigger>
                      <DialogContent className="sm:max-w-[420px]">
                        <DialogHeader className="text-left">
                          <DialogTitle className="font-medium">Remove Lumen key?</DialogTitle>
                          <DialogDescription>The key &quot;{item.label}&quot; will no longer be available as a fallback.</DialogDescription>
                        </DialogHeader>
                        {deleteError && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{deleteError}</p>}
                        <DialogFooter>
                          <DialogClose asChild>
                            <button type="button" disabled={deleting} className="min-h-8 cursor-pointer rounded-[7px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-900">Cancel</button>
                          </DialogClose>
                          <Button variant="destructive" disabled={deleting} onClick={async () => {
                            if (deleting) return;
                            setDeleting(true);
                            setDeleteError("");
                            try {
                              await deleteByokKey({ data: { id: item.id } });
                              setKeys((current) => current?.filter((existing) => existing.id !== item.id) ?? []);
                              setDeletingId(null);
                            } catch (error) {
                              setDeleteError(error instanceof Error ? error.message : "Couldn't remove the key. Try again.");
                            } finally {
                              setDeleting(false);
                            }
                          }}>{deleting ? "Removing…" : "Remove key"}</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                </Td>
              </>
            )}
          />
        </DataTable>
      )}
    </section>
  );
}
