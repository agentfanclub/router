import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/button";
import { signInReturn } from "../lib/sign-in-return";

export const Route = createFileRoute("/login_/verify")({
  validateSearch: (search: Record<string, unknown>): { token?: string; returnTo?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    returnTo: signInReturn(search.returnTo),
  }),
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: VerifyLink,
});

function VerifyLink() {
  const { token, returnTo } = Route.useSearch();
  const [busy, setBusy] = useState(false);

  function signIn() {
    if (!token) return;
    setBusy(true);
    const callbackURL = signInReturn(returnTo);
    const query = new URLSearchParams({ token, callbackURL, errorCallbackURL: `/login?${new URLSearchParams({ returnTo: callbackURL })}` });
    window.location.replace(`/api/auth/magic-link/verify?${query}`);
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-white px-6 py-16 text-neutral-800">
      <section className="w-full max-w-[360px]" aria-labelledby="verify-title">
        <img src="/agent-fan-club.png" alt="Agent fan club" className="mb-7 -ml-2 h-auto w-40" />
        <h1 id="verify-title" className="text-xl font-medium tracking-tight">{token ? "Confirm your sign-in" : "This sign-in link is incomplete"}</h1>
        <p className="mt-1 text-[13px] leading-5 text-neutral-500">
          {token ? "You opened a sign-in link from your email. Click below to finish signing in to Router." : "Request a new link to sign in."}
        </p>
        {token && <p className="mt-3 text-xs leading-5 text-neutral-400">Your link expires 5 minutes after the email was sent.</p>}
        <div className="mt-9 flex justify-end">
          {token ? (
            <Button arrow loading={busy} onClick={signIn}>Confirm and sign in</Button>
          ) : (
            <Link to="/login" className="text-sm underline underline-offset-4">Back to sign in</Link>
          )}
        </div>
      </section>
    </main>
  );
}
