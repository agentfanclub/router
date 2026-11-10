import { drizzle } from "drizzle-orm/d1";
import { Context, Data, Effect, Layer } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/http";
import { createAuth } from "./auth";
import type { AdmitInput, AdmitResult, SettleInput, UsageSnapshot, UserUsage } from "./do/user-usage";
import type { ApiEnv } from "./env";
import type { UsageLimits } from "./util/usage";

export class WorkerEnv extends Context.Service<WorkerEnv, ApiEnv>()("router/WorkerEnv") { }

export class WorkerExecution extends Context.Service<WorkerExecution, ExecutionContext>()("router/WorkerExecution") { }

export type Database = ReturnType<typeof drizzle>;

export class Db extends Context.Service<Db, Database>()("router/Db") { }

export class DbError extends Data.TaggedError("DbError")<{ cause: unknown }> {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Something went wrong. Try again." }, { status: 500 }));
  }
}

export const query = <A>(run: (db: Database) => Promise<A>): Effect.Effect<A, DbError, Db> =>
  Db.use((db) => Effect.tryPromise({ try: () => run(db), catch: (cause) => new DbError({ cause }) }));

export type AuthClient = ReturnType<typeof createAuth>;
export type AuthSession = AuthClient["$Infer"]["Session"];

export class Auth extends Context.Service<Auth, AuthClient>()("router/Auth") { }

export const getSession = (headers: HeadersInit): Effect.Effect<AuthSession | null, never, Auth> =>
  Auth.use((auth) => Effect.tryPromise(() => auth.api.getSession({ headers: new Headers(headers) })).pipe(
    Effect.orElseSucceed(() => null),
  ));

export class UsageUnavailable extends Data.TaggedError("UsageUnavailable")<{ cause: unknown }> { }

// The per-user usage Durable Object, addressed by user ID.
export class UsageCoordinator extends Context.Service<UsageCoordinator, {
  admit(input: AdmitInput): Effect.Effect<AdmitResult, UsageUnavailable>;
  settle(userId: string, input: SettleInput): Effect.Effect<UsageSnapshot, UsageUnavailable>;
  status(userId: string, limits: UsageLimits): Effect.Effect<UsageSnapshot, UsageUnavailable>;
}>()("router/UsageCoordinator") { }

function usageCoordinator(env: ApiEnv): UsageCoordinator["Service"] {
  const call = <A>(userId: string, run: (stub: DurableObjectStub<UserUsage>) => PromiseLike<unknown>) =>
    Effect.tryPromise({
      // A fresh stub per call: a stub that saw an error can stay broken.
      // RPC wraps results in disposable proxies, so the declared type is used.
      try: () => run(env.USER_USAGE.getByName(userId)) as Promise<A>,
      catch: (cause) => new UsageUnavailable({ cause }),
    });
  return {
    admit: (input) => call<AdmitResult>(input.userId, (stub) => stub.admit(input)),
    settle: (userId, input) => call<UsageSnapshot>(userId, (stub) => stub.settle(input)),
    status: (userId, limits) => call<UsageSnapshot>(userId, (stub) => stub.status(limits)),
  };
}

export const servicesLayer = (env: ApiEnv): Layer.Layer<WorkerEnv | Db | Auth | UsageCoordinator> => Layer.mergeAll(
  Layer.succeed(WorkerEnv, env),
  Layer.succeed(Db, drizzle(env.DB)),
  Layer.succeed(Auth, createAuth(env)),
  Layer.succeed(UsageCoordinator, usageCoordinator(env)),
);
