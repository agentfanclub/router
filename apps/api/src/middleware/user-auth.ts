import { Context, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createAuth } from "../auth";
import { WorkerEnv } from "../worker-env";

type Auth = ReturnType<typeof createAuth>;
type Session = Auth["$Infer"]["Session"];

export class UserSession extends Context.Service<UserSession, Session>()("router/UserSession") { }

export const userAuth = HttpRouter.middleware<{ provides: UserSession }>()(
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const auth = createAuth(env);

    return (handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* Effect.promise(() => auth.api.getSession({
        headers: new Headers(request.headers),
      }));

      if (!session) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Unauthorized" },
          { status: 401 },
        );
      }

      return yield* Effect.provideService(handler, UserSession, session);
    }).pipe(
      Effect.map(HttpServerResponse.setHeader("Cache-Control", "no-store")),
    );
  }),
).layer;
