import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";
import { getSession } from "../lib/session";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { error?: string } => ({ error: typeof search.error === "string" ? search.error : undefined }),
  loader: async () => {
    if (await getSession()) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const router = useRouter();
  const search = Route.useSearch();
  const [netid, setNetid] = useState("");
  const [method, setMethod] = useState<"otp" | "link">("otp");
  const [sent, setSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(search.error ? "That sign-in link is invalid or has expired. Request a new one." : "");
  const email = `${netid.trim().toLowerCase()}@illinois.edu`;

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = method === "otp"
        ? await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })
        : await authClient.signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/login" });
      if (result.error) throw new Error(result.error.message || "Couldn't send your email.");
      setSent(true);
      setOtp("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't send your email. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.emailOtp({ email, otp });
      if (result.error) throw new Error(result.error.message || "Couldn't verify your code.");
      await router.invalidate();
      await router.navigate({ to: "/" });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't verify your code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-12 text-slate-900">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm" aria-labelledby="login-title">
        <p className="text-sm font-semibold uppercase tracking-widest text-orange-700">Router</p>
        <h1 id="login-title" className="mt-6 text-3xl font-semibold tracking-tight">Sign in with your NetID</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">Use your Illinois email to get a sign-in code or magic link. No password needed.</p>

        {!sent ? (
          <form onSubmit={send} className="mt-8 space-y-6">
            <div>
              <label htmlFor="netid" className="mb-2 block text-sm font-medium">Illinois NetID</label>
              <div className="flex rounded-lg border border-slate-300 focus-within:ring-2 focus-within:ring-orange-600">
                <input id="netid" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required pattern="[a-zA-Z][a-zA-Z0-9]*" title="Enter just your NetID, without @illinois.edu" value={netid} onChange={(event) => setNetid(event.target.value)} disabled={busy} aria-describedby="email-domain" className="min-w-0 flex-1 rounded-l-lg px-3 py-3 outline-none" placeholder="yournetid" />
                <span id="email-domain" className="flex items-center rounded-r-lg bg-slate-100 px-3 text-sm text-slate-600">@illinois.edu</span>
              </div>
            </div>
            <fieldset disabled={busy}>
              <legend className="mb-3 text-sm font-medium">How would you like to sign in?</legend>
              <div className="flex gap-5 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="method" value="otp" checked={method === "otp"} onChange={() => setMethod("otp")} />Email code</label>
                <label className="flex items-center gap-2"><input type="radio" name="method" value="link" checked={method === "link"} onChange={() => setMethod("link")} />Magic link</label>
              </div>
            </fieldset>
            <button disabled={busy} className="w-full rounded-lg bg-orange-700 px-4 py-3 font-medium text-white hover:bg-orange-800 disabled:opacity-50">{busy ? "Sending…" : method === "otp" ? "Send sign-in code" : "Send magic link"}</button>
          </form>
        ) : (
          <div className="mt-8">
            <p role="status" className="text-sm leading-6 text-slate-600">{method === "otp" ? "Enter the 6-digit code sent to" : "Open the sign-in link sent to"} <strong className="break-all text-slate-900">{email}</strong>. It expires in 5 minutes.</p>
            {method === "otp" && (
              <form onSubmit={verify} className="mt-6 space-y-4">
                <label htmlFor="otp" className="block text-sm font-medium">Sign-in code</label>
                <input id="otp" name="otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus disabled={busy} value={otp} onChange={(event) => setOtp(event.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-3 text-center text-2xl tracking-widest focus:ring-2 focus:ring-orange-600" />
                <button disabled={busy} className="w-full rounded-lg bg-orange-700 px-4 py-3 font-medium text-white hover:bg-orange-800 disabled:opacity-50">{busy ? "Verifying…" : "Sign in"}</button>
              </form>
            )}
            <button type="button" disabled={busy} onClick={() => { setSent(false); setError(""); setOtp(""); }} className="mt-6 text-sm text-orange-800 underline disabled:opacity-50">Try again or change sign-in method</button>
          </div>
        )}
        {error && <p role="alert" className="mt-5 text-sm text-red-700">{error}</p>}
      </section>
    </main>
  );
}
