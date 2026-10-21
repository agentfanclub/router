import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { deviceClients, isDeviceClient } from "../../../api/src/device-clients";
import { Button } from "../components/button";
import { answerDeviceApproval, getDeviceApproval } from "../lib/device-auth";
import { getSession } from "../lib/session";

export const Route = createFileRoute("/connect/$client")({
  validateSearch: (search: Record<string, unknown>) => ({ code: typeof search.code === "string" ? search.code : "" }),
  loaderDeps: ({ search }) => ({ code: search.code }),
  remountDeps: ({ search }) => search.code,
  loader: async ({ deps, params }) => {
    if (!isDeviceClient(params.client)) {
      throw new Error("Unknown connection client.");
    }
    const session = await getSession();
    if (!session) return { session: null, attempt: null, error: "" };
    try {
      const attempt = await getDeviceApproval({ data: { code: deps.code } });
      if (attempt.client !== params.client) throw new Error("This code belongs to a different application. Open the link from your terminal.");
      return { session, attempt, error: "" };
    } catch (error) {
      return { session, attempt: null, error: error instanceof Error ? error.message : "Couldn't load this connection." };
    }
  },
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }, { name: "robots", content: "noindex" }] }),
  component: ConnectClient,
});

function ConnectClient() {
  const { client } = Route.useParams();
  const clientName = isDeviceClient(client) ? deviceClients[client] : "application";
  const { code } = Route.useSearch();
  const { session, attempt, error: loadError } = Route.useLoaderData();
  const [status, setStatus] = useState(attempt?.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const validCode = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(code);

  async function answer(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const result = await answerDeviceApproval({ data: { code, decision } });
      setStatus(result.status);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't answer this request. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-white px-6 py-16 text-neutral-800">
      <section className="w-full max-w-[400px]" aria-labelledby="connect-title">
        <img src="/agent-fan-club.png" alt="Agent fan club" className="mb-7 -ml-2 h-auto w-40" />
        <h1 id="connect-title" className="text-xl font-medium tracking-tight">
          {status === "approved" ? `${clientName} approved` : status === "denied" ? "Connection declined" : `Connect ${clientName}`}
        </h1>
        {status === "approved" || status === "denied" ? (
          <p role="status" className="mt-3 text-sm leading-6 text-neutral-500">
            {status === "approved" ? `Return to ${clientName} to finish connecting. You can disable or delete its key from API Keys.` : "This request was declined. You can close this page."}
          </p>
        ) : !validCode || loadError ? (
          <p role="alert" className="mt-3 text-sm leading-6 text-red-700">{loadError || "This connection link is incomplete. Start again in your terminal."}</p>
        ) : !session ? (
          <>
            <p className="mt-3 text-sm leading-6 text-neutral-500">Sign in to choose the account {clientName} will use.</p>
            <div className="mt-7">
              <Link to="/login" search={{ returnTo: `/connect/${client}?code=${code}` }} className="text-sm underline underline-offset-4">Sign in to Agent Fan Club</Link>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm leading-6 text-neutral-500">{clientName} will receive an API key for <span className="break-all text-neutral-800">{session.user.email}</span> and can send model requests through your account.</p>
            <p className="mt-5 text-[13px] leading-5 text-neutral-500">Only approve if you started this request in {clientName} and the code below matches your terminal.</p>
            <code className="mt-3 block rounded border border-neutral-200 bg-neutral-50 px-3 py-3 text-center text-base tracking-wider">{code}</code>
            <p className="mt-3 text-xs leading-5 text-neutral-500">This request expires 10 minutes after it starts. You can revoke access from API Keys at any time.</p>
            <div className="mt-7 flex justify-between gap-3">
              <Button variant="destructive" disabled={busy} onClick={() => answer("deny")}>Decline</Button>
              <Button loading={busy} onClick={() => answer("approve")}>Connect {clientName}</Button>
            </div>
          </>
        )}
        {error && <p role="alert" className="mt-4 text-xs leading-5 text-red-700">{error}</p>}
      </section>
    </main>
  );
}
