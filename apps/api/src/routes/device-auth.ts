import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { deviceAuthorization } from "../db/schema";
import { deviceClients, isDeviceClient } from "../device-clients";
import { UserSession, userAuth } from "../middleware/user-auth";
import { WorkerEnv } from "../worker-env";
import { createDeviceApiKey } from "../util/keys";

const requestLifetimeMs = 10 * 60 * 1000;
const pollIntervalSeconds = 5;
const codePattern = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/;
const noStore = { "Cache-Control": "no-store" };

const approvalFields = {
  client: deviceAuthorization.client,
  userCode: deviceAuthorization.userCode,
  status: deviceAuthorization.status,
  expiresAt: deviceAuthorization.expiresAt,
};

export type DeviceApproval = Pick<typeof deviceAuthorization.$inferSelect, "client" | "userCode" | "status"> & {
  expiresAt: string;
};

const approvalRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/device/authorization/:code", Effect.gen(function* () {
    const env = yield* WorkerEnv;

    const { code } = yield* HttpRouter.params;
    if (!code || !codePattern.test(code)) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid connection code." }, { status: 400 });
    }

    const [attempt] = yield* Effect.promise(() => drizzle(env.DB)
      .select(approvalFields)
      .from(deviceAuthorization)
      .where(and(eq(deviceAuthorization.userCode, code), gt(deviceAuthorization.expiresAt, new Date())))
      .limit(1));

    if (!attempt) {
      return HttpServerResponse.jsonUnsafe({ error: "This connection code has expired or was already used. Start again in your terminal." }, { status: 404 });
    }

    return HttpServerResponse.jsonUnsafe(attempt);
  })),

  HttpRouter.add("POST", "/api/device/authorization/:code", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    if (request.headers.origin !== new URL(env.BETTER_AUTH_URL).origin) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid request origin." }, { status: 403 });
    }

    const { code } = yield* HttpRouter.params;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!code || !codePattern.test(code) || !body || typeof body !== "object" ||
      !("decision" in body) || (body.decision !== "approve" && body.decision !== "deny")) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid connection request." }, { status: 400 });
    }

    const status = body.decision === "approve" ? "approved" : "denied";
    const [attempt] = yield* Effect.promise(() => drizzle(env.DB)
      .update(deviceAuthorization)
      .set({ status, userId: session.user.id })
      .where(and(
        eq(deviceAuthorization.userCode, code),
        eq(deviceAuthorization.status, "pending"),
        gt(deviceAuthorization.expiresAt, new Date()),
      ))
      .returning(approvalFields));

    if (!attempt) {
      return HttpServerResponse.jsonUnsafe({ error: "This request has expired or was already answered. Start again in your terminal." }, { status: 409 });
    }

    return HttpServerResponse.jsonUnsafe(attempt);
  })),
).pipe(Layer.provide(userAuth));

export const deviceAuthRoutes = Layer.mergeAll(
  approvalRoutes,
  HttpRouter.add("POST", "/api/device/code", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;

    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!body || typeof body !== "object" || !("client" in body) ||
      !isDeviceClient(body.client)) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid client." }, { status: 400, headers: noStore });
    }

    const client = body.client;
    const db = drizzle(env.DB);
    const now = Date.now();
    const deviceCode = randomBytes(32).toString("hex");
    const userCode = randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
    const expiresAt = new Date(now + requestLifetimeMs);

    yield* Effect.promise(() => db.batch([
      db.delete(deviceAuthorization).where(lt(deviceAuthorization.expiresAt, new Date(now))),
      db.insert(deviceAuthorization).values({
        deviceCodeHash: createHash("sha256").update(deviceCode).digest("hex"),
        userCode,
        client,
        expiresAt,
        nextPollAt: new Date(now + pollIntervalSeconds * 1000),
      }),
    ]));

    const verificationURL = new URL(`/connect/${client}`, env.BETTER_AUTH_URL);
    verificationURL.searchParams.set("code", userCode);

    return HttpServerResponse.jsonUnsafe({
      deviceCode,
      userCode,
      verificationURL: verificationURL.href,
      expiresAt: expiresAt.toISOString(),
      interval: pollIntervalSeconds,
    }, { headers: noStore });
  })),

  HttpRouter.add("POST", "/api/device/token", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;

    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!body || typeof body !== "object" || !("deviceCode" in body) ||
      typeof body.deviceCode !== "string" || !/^[a-f0-9]{64}$/.test(body.deviceCode)) {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 400, headers: noStore });
    }

    const hash = createHash("sha256").update(body.deviceCode).digest("hex");
    const now = Date.now();

    const db = drizzle(env.DB);
    const [attempt] = yield* Effect.promise(() => db.update(deviceAuthorization)
      .set({ nextPollAt: new Date(now + pollIntervalSeconds * 1000) })
      .where(and(
        eq(deviceAuthorization.deviceCodeHash, hash),
        gt(deviceAuthorization.expiresAt, new Date(now)),
        lte(deviceAuthorization.nextPollAt, new Date(now)),
      ))
      .returning({ status: deviceAuthorization.status, client: deviceAuthorization.client }));

    if (!attempt) {
      const [existing] = yield* Effect.promise(() => db.select({ expiresAt: deviceAuthorization.expiresAt })
        .from(deviceAuthorization).where(eq(deviceAuthorization.deviceCodeHash, hash)).limit(1));
      const error = existing && existing.expiresAt.getTime() > now ? "slow_down" : "expired_token";
      return HttpServerResponse.jsonUnsafe({ error }, { status: 400, headers: noStore });
    }

    if (attempt.status !== "approved") {
      const error = attempt.status === "denied" ? "access_denied" : "authorization_pending";
      return HttpServerResponse.jsonUnsafe({ error }, { status: 400, headers: noStore });
    }

    const token = yield* Effect.promise(() => createDeviceApiKey({
      db,
      deviceCodeHash: hash,
      name: deviceClients[attempt.client],
    }));

    if (!token) {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 400, headers: noStore });
    }

    return HttpServerResponse.jsonUnsafe({ token }, { headers: noStore });
  })),
);
