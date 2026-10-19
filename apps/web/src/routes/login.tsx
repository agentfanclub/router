import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Fragment, useRef, useState, type FormEvent } from "react";
import { Button } from "../components/button";
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
  const [sent, setSent] = useState(false);
  const [otp, setOtp] = useState<string[]>(Array(6).fill(""));
  const otpInputs = useRef<(HTMLInputElement | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(search.error === "account_not_linked"
    ? "An account already exists for this email. Sign in with an email link or code."
    : search.error ? "Sign-in failed. Please try again." : "");
  const email = `${netid.trim().toLowerCase()}@illinois.edu`;

  function enterDigits(value: string, index: number) {
    const digits = value.replace(/\D/g, "").slice(0, 6);
    if (value && !digits) return;
    const start = digits.length === 6 ? 0 : index;
    setOtp((current) => {
      const next = [...current];
      if (!digits) next[index] = "";
      else for (let offset = 0; offset < digits.length && start + offset < 6; offset++) {
        next[start + offset] = digits[offset]!;
      }
      return next;
    });
    if (digits) otpInputs.current[Math.min(start + digits.length, 5)]?.focus();
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/login" });
      if (result.error) throw new Error(result.error.message || "Couldn't send your email.");
      setSent(true);
      setOtp(Array(6).fill(""));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't send your email. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithIllinois() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider: "microsoft",
        callbackURL: "/",
        errorCallbackURL: "/login",
      });
      if (result.error) throw new Error(result.error.message || "Couldn't start Illinois sign-in.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't start Illinois sign-in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.emailOtp({ email, otp: otp.join("") });
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
    <main className="flex min-h-svh items-center justify-center bg-white px-6 py-16 text-neutral-800">
      <section className="w-full max-w-[360px]" aria-labelledby="login-title">
        <img src="/agent-fan-club.png" alt="Agent fan club" className="mb-7 -ml-2 h-auto w-40" />
        <h1 id="login-title" className="text-xl font-medium tracking-tight">{sent ? "Check your email" : "Sign in with your NetID"}</h1>
        <p className="mt-1 text-[13px] leading-5 text-neutral-500">
          {sent ? <>Click the link we sent to <span className="break-all text-neutral-700">{email}</span> or enter the code below.</> : "We'll create an account if you don't have one."}
        </p>

        {!sent ? (
          <>
            <div className="mt-8">
              <Button onClick={signInWithIllinois} loading={busy} className="button-illinois w-full">
                <img src="/illinois-block-i.svg" alt="" aria-hidden="true" className="h-4 w-auto" />
                Sign in with Illinois
              </Button>
            </div>
            <div className="mt-6 flex items-center gap-3 text-xs text-neutral-400">
              <span className="h-px flex-1 bg-neutral-200" />
              <span>or use an email link or code</span>
              <span className="h-px flex-1 bg-neutral-200" />
            </div>
            <form onSubmit={send} className="mt-6 space-y-4">
              <label htmlFor="netid" className="sr-only">Illinois NetID</label>
              <div className="auth-input flex items-center">
                <input id="netid" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required pattern="[a-zA-Z][a-zA-Z0-9]*" title="Enter just your NetID, without @illinois.edu" value={netid} onChange={(event) => setNetid(event.target.value)} disabled={busy} aria-describedby="email-domain" className="min-w-0 flex-1 bg-transparent py-2.5 pl-3 text-sm outline-none placeholder:text-neutral-400" placeholder="netid" />
                <span id="email-domain" className="pr-3 text-[13px] text-neutral-400">@illinois.edu</span>
              </div>
              <div className="flex justify-end">
                <Button type="submit" arrow loading={busy}>Continue</Button>
              </div>
            </form>
          </>
        ) : (
          <form onSubmit={verify} className="mt-9 space-y-4">
            <div role="group" aria-label="Sign-in code" aria-describedby="code-expiry" className="flex items-center">
              {otp.map((digit, index) => (
                <Fragment key={index}>
                  {index === 3 && <span aria-hidden="true" className="px-3 text-neutral-400">-</span>}
                  <input
                    ref={(input) => { otpInputs.current[index] = input; }}
                    aria-label={`Digit ${index + 1}`}
                    name={`otp-${index + 1}`}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? "one-time-code" : "off"}
                    pattern="[0-9]"
                    maxLength={6}
                    required
                    autoFocus={index === 0}
                    disabled={busy}
                    value={digit}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => enterDigits(event.target.value, index)}
                    onPaste={(event) => {
                      event.preventDefault();
                      enterDigits(event.clipboardData.getData("text"), index);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Backspace" && !digit && index > 0) {
                        event.preventDefault();
                        setOtp((current) => current.map((value, position) => position === index - 1 ? "" : value));
                        otpInputs.current[index - 1]?.focus();
                      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        event.preventDefault();
                        otpInputs.current[index + (event.key === "ArrowLeft" ? -1 : 1)]?.focus();
                      }
                    }}
                    className="auth-input otp-digit h-11 min-w-0 flex-1 text-center text-lg outline-none disabled:opacity-50"
                  />
                </Fragment>
              ))}
            </div>
            <p id="code-expiry" className="text-xs text-neutral-400">The link and code expire in 5 minutes.</p>
            <div className="flex items-center justify-between gap-4">
              <button type="button" disabled={busy} onClick={() => { setSent(false); setNetid(""); setError(""); setOtp(Array(6).fill("")); }} className="cursor-pointer text-xs text-neutral-500 underline decoration-neutral-300 underline-offset-4 transition-colors enabled:hover:text-neutral-900 enabled:hover:decoration-neutral-700 disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none">Try another email</button>
              <Button type="submit" arrow loading={busy}>Sign in</Button>
            </div>
          </form>
        )}
        {error && <p role="alert" className="mt-4 text-xs leading-5 text-red-700">{error}</p>}
      </section>
    </main>
  );
}
