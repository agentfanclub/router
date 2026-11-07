import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, lte } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { deviceAuthorization } from "../db/schema";
import { deviceClients, type DeviceClient } from "../device-clients";
import { ApiError, decodeBody, failWith } from "../http";
import { UserSession, userAuth } from "../middleware/user-auth";
import { Db, query, WorkerEnv } from "../services";
import { createDeviceApiKey } from "../util/keys";

const requestLifetimeMs = 10 * 60 * 1000;
const pollIntervalSeconds = 5;
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

const UserCode = Schema.String.check(Schema.isPattern(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/));

const userCode = (message: string) => HttpRouter.schemaParams(Schema.Struct({ code: UserCode })).pipe(
  Effect.map(({ code }) => code),
  Effect.mapError(() => new ApiError({ status: 400, message })),
);

const Decision = Schema.Struct({ decision: Schema.Literals(["approve", "deny"]) });

const CodeRequest = Schema.Struct({
  client: Schema.Literals(Object.keys(deviceClients) as [DeviceClient, ...DeviceClient[]]),
});

const TokenRequest = Schema.Struct({
  deviceCode: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

// OAuth device flow errors are bare error codes.
const oauthError = (error: string) => failWith(400, error, noStore);

const approvalRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/device/authorization/:code", Effect.fn("getDeviceAuthorization")(function* () {
    const code = yield* userCode("Invalid connection code.");
    const [attempt] = yield* query((db) => db
      .select(approvalFields)
      .from(deviceAuthorization)
      .where(and(eq(deviceAuthorization.userCode, code), gt(deviceAuthorization.expiresAt, new Date())))
      .limit(1));
    if (!attempt) {
      return yield* failWith(404, "This connection code has expired or was already used. Start again in your terminal.");
    }
    return HttpServerResponse.jsonUnsafe(attempt);
  })),

  HttpRouter.add("POST", "/api/device/authorization/:code", Effect.fn("answerDeviceAuthorization")(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.origin !== new URL(env.BETTER_AUTH_URL).origin) {
      return yield* failWith(403, "Invalid request origin.");
    }
    const code = yield* userCode("Invalid connection request.");
    const { decision } = yield* decodeBody(Decision, "Invalid connection request.");

    const [attempt] = yield* query((db) => db
      .update(deviceAuthorization)
      .set({ status: decision === "approve" ? "approved" : "denied", userId: session.user.id })
      .where(and(
        eq(deviceAuthorization.userCode, code),
        eq(deviceAuthorization.status, "pending"),
        gt(deviceAuthorization.expiresAt, new Date()),
      ))
      .returning(approvalFields));
    if (!attempt) {
      return yield* failWith(409, "This request has expired or was already answered. Start again in your terminal.");
    }
    return HttpServerResponse.jsonUnsafe(attempt);
  })),
).pipe(Layer.provide(userAuth));

export const deviceAuthRoutes = Layer.mergeAll(
  approvalRoutes,

  HttpRouter.add("POST", "/api/device/code", Effect.fn("createDeviceCode")(function* () {
    const env = yield* WorkerEnv;
    const { client } = yield* decodeBody(CodeRequest, "Invalid client.", noStore);
    const now = Date.now();
    const deviceCode = randomBytes(32).toString("hex");
    const userCode = randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
    const expiresAt = new Date(now + requestLifetimeMs);

    yield* query((db) => db.batch([
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

  HttpRouter.add("POST", "/api/device/token", Effect.fn("redeemDeviceCode")(function* () {
    const { deviceCode } = yield* decodeBody(TokenRequest, "invalid_grant", noStore);
    const hash = createHash("sha256").update(deviceCode).digest("hex");
    const now = Date.now();

    const [attempt] = yield* query((db) => db.update(deviceAuthorization)
      .set({ nextPollAt: new Date(now + pollIntervalSeconds * 1000) })
      .where(and(
        eq(deviceAuthorization.deviceCodeHash, hash),
        gt(deviceAuthorization.expiresAt, new Date(now)),
        lte(deviceAuthorization.nextPollAt, new Date(now)),
      ))
      .returning({ status: deviceAuthorization.status, client: deviceAuthorization.client }));

    if (!attempt) {
      const [existing] = yield* query((db) => db.select({ expiresAt: deviceAuthorization.expiresAt })
        .from(deviceAuthorization).where(eq(deviceAuthorization.deviceCodeHash, hash)).limit(1));
      return yield* oauthError(existing && existing.expiresAt.getTime() > now ? "slow_down" : "expired_token");
    }
    if (attempt.status !== "approved") {
      return yield* oauthError(attempt.status === "denied" ? "access_denied" : "authorization_pending");
    }

    const db = yield* Db;
    const token = yield* query(() => createDeviceApiKey({ db, deviceCodeHash: hash, name: deviceClients[attempt.client] }));
    if (!token) return yield* oauthError("invalid_grant");
    return HttpServerResponse.jsonUnsafe({ token }, { headers: noStore });
  })),
);
