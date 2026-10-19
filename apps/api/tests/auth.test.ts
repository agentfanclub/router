import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createAuth, type AuthEnv } from "../src/auth";

const delivery = vi.hoisted(() => vi.fn());
vi.mock("resend", () => ({ Resend: class { emails = { send: delivery }; } }));

let mf: Miniflare;
let db: D1Database;
let auth: ReturnType<typeof createAuth>;
let authEnv: AuthEnv;
const origin = "http://localhost:3000";
let ip = 0;

function request(path: string, body?: unknown, cookie?: string) {
  return auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "cf-connecting-ip": `192.0.2.${++ip}`,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "auth-test", modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB"] }] }));
  db = await mf.getD1Database("DB", "auth-test") as unknown as D1Database;
  const directory = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = await readFile(new URL(file, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  authEnv = {
    DB: db,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
    RESEND_API_KEY: "re_test",
    RESEND_FROM_EMAIL: "Router <auth@example.com>",
  } satisfies AuthEnv;
  auth = createAuth(authEnv);
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(() => { delivery.mockReset().mockResolvedValue({ data: { id: "test" }, error: null }); });

describe("Illinois passwordless auth", () => {
  it.each(["person@gmail.com", "netid@illinois.edu.evil.com", "netid@sub.illinois.edu", "netid+alias@illinois.edu"])("rejects %s for both sign-in methods before sending email", async (email) => {
    for (const [path, body] of [
      ["/sign-in/magic-link", { email, callbackURL: "/" }],
      ["/email-otp/send-verification-otp", { email, type: "sign-in" }],
      ["/sign-in/email-otp", { email, otp: "123456" }],
    ] as const) {
      const response = await request(path, body);
      expect(response.status).toBe(400);
    }
    expect(delivery).not.toHaveBeenCalled();
  });

  it("signs in with an OTP, persists a session, rejects reuse, and signs out", async () => {
    const email = "otpuser@illinois.edu";
    expect((await request("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    const message = delivery.mock.calls[0][0];
    expect(message.to).toBe(email);
    const otp = message.text.match(/code is (\d{6})/)[1];
    const records = await db.prepare("SELECT value FROM verification").all();
    expect(JSON.stringify(records)).not.toContain(otp);
    const wrong = otp === "000000" ? "111111" : "000000";
    expect((await request("/sign-in/email-otp", { email, otp: wrong })).ok).toBe(false);
    const response = await request("/sign-in/email-otp", { email, otp });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const session = await (await request("/get-session", undefined, cookie)).json();
    expect(session.user.email).toBe(email);
    expect(session.user.emailVerified).toBe(true);
    expect((await request("/sign-in/email-otp", { email, otp })).ok).toBe(false);
    expect((await request("/sign-out", {}, cookie)).status).toBe(200);
    expect(await (await request("/get-session", undefined, cookie)).json()).toBeNull();
  });

  it("signs in with a magic link and rejects reuse", async () => {
    const email = "linkuser@illinois.edu";
    expect((await request("/sign-in/magic-link", { email, callbackURL: "/", errorCallbackURL: "/login" })).status).toBe(200);
    const url = delivery.mock.calls[0][0].text.match(/http[^\s]+/)[0];
    expect(new URL(url).origin).toBe(origin);
    const response = await auth.handler(new Request(url));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!, origin).pathname).toBe("/");
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect((await (await request("/get-session", undefined, cookie)).json()).user.email).toBe(email);
    const reused = await auth.handler(new Request(url));
    expect(reused.headers.get("location")).toContain("error=");
  });

  it("rejects expired OTPs", async () => {
    const email = "expired@illinois.edu";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const otp = delivery.mock.calls[0][0].text.match(/code is (\d{6})/)[1];
    await db.prepare("UPDATE verification SET expires_at = 0").run();
    expect((await request("/sign-in/email-otp", { email, otp })).ok).toBe(false);
  });

  it("rejects an expired magic link", async () => {
    await request("/sign-in/magic-link", { email: "expiredlink@illinois.edu", callbackURL: "/", errorCallbackURL: "/login" });
    const url = delivery.mock.calls[0][0].text.match(/http[^\s]+/)[0];
    await db.prepare("UPDATE verification SET expires_at = 0").run();
    const response = await auth.handler(new Request(url));
    expect(response.headers.get("location")).toContain("error=");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("invalidates an OTP after too many incorrect attempts", async () => {
    const email = "attempts@illinois.edu";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const otp = delivery.mock.calls[0][0].text.match(/code is (\d{6})/)[1];
    const wrong = otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await request("/sign-in/email-otp", { email, otp: wrong })).ok).toBe(false);
    }
    expect((await request("/sign-in/email-otp", { email, otp })).ok).toBe(false);
  });

  it("reports delivery failures without claiming an email was sent", async () => {
    delivery.mockResolvedValue({ data: null, error: { message: "Provider rejected sender" } });
    for (const [path, body] of [
      ["/sign-in/magic-link", { email: "failure@illinois.edu", callbackURL: "/" }],
      ["/email-otp/send-verification-otp", { email: "failure@illinois.edu", type: "sign-in" }],
    ] as const) {
      expect((await request(path, body)).status).toBe(500);
    }
  });

  it("rejects untrusted origins and redirect URLs", async () => {
    const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST", headers: { origin: "https://evil.example", cookie: "test=1", "content-type": "application/json" },
      body: JSON.stringify({ email: "netid@illinois.edu", callbackURL: "/" }),
    }));
    expect(response.status).toBe(403);
    expect((await request("/sign-in/magic-link", { email: "netid@illinois.edu", callbackURL: "https://evil.example" })).status).toBe(403);
    expect(delivery).not.toHaveBeenCalled();
  });

  it("limits repeated email requests across auth instances", async () => {
    const headers = { origin, "content-type": "application/json", "cf-connecting-ip": "198.51.100.1" };
    const send = () => createAuth(authEnv).handler(new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST", headers, body: JSON.stringify({ email: "limited@illinois.edu", type: "sign-in" }),
    }));
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});
