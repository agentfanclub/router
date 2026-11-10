import { Context, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { failWith } from "../http";
import { Auth, getSession, type AuthSession } from "../services";

export class UserSession extends Context.Service<UserSession, AuthSession>()("router/UserSession") { }

export const userAuthMiddleware = HttpRouter.middleware<{ provides: UserSession }>()(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return (handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* getSession(request.headers).pipe(Effect.provideService(Auth, auth));
      if (!session) return yield* failWith(401, "Unauthorized");
      return yield* Effect.provideService(handler, UserSession, session);
    }).pipe(
      Effect.map(HttpServerResponse.setHeader("Cache-Control", "no-store")),
    );
  }),
);

export const userAuth = userAuthMiddleware.layer;
