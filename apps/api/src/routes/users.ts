import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { user } from "../db/schema";
import { UserSession, userAuth } from "../middleware/user-auth";
import { WorkerEnv } from "../worker-env";

export type User = Pick<typeof user.$inferSelect, "id" | "name" | "email" | "role">;

export const userRoutes = HttpRouter.add("GET", "/api/users", Effect.gen(function* () {
  const session = yield* UserSession;
  if (session.user.role !== "admin") {
    return HttpServerResponse.jsonUnsafe({ error: "Forbidden" }, { status: 403 });
  }

  const env = yield* WorkerEnv;
  const users = yield* Effect.promise(() => drizzle(env.DB)
    .select({ id: user.id, name: user.name, email: user.email, role: user.role })
    .from(user)
    .orderBy(asc(user.email)),
  );
  return HttpServerResponse.jsonUnsafe(users);
})).pipe(Layer.provide(userAuth));
