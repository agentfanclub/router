import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/button";
import { authClient } from "../lib/auth-client";
import { getSession } from "../lib/session";

export const Route = createFileRoute("/")({
  loader: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    return session;
  },
  component: Home,
});

function Home() {
  const { user } = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Couldn't sign out.");
      await router.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't sign out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-orange-700">Router</p>
      <h1 className="mt-4 text-3xl font-semibold">You're signed in.</h1>
      <p className="mt-3 text-slate-600">{user.email}</p>
      <Button className="mt-8" loading={busy} onClick={signOut}>Sign out</Button>
      {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
    </main>
  );
}
