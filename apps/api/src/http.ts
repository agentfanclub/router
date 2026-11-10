import { Data, Effect, type Schema } from "effect";
import { HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/http";

// An error the client should see, rendered as `{ error: message }`.
export class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  message: string;
  headers?: Record<string, string>;
}> {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: this.message }, { status: this.status, headers: this.headers }));
  }
}

export const failWith = (status: number, message: string, headers?: Record<string, string>) =>
  Effect.fail(new ApiError({ status, message, headers }));

// Decodes the JSON body, answering 400 with `message` when it does not fit.
export const decodeBody = <A, RD>(schema: Schema.ConstraintDecoder<A, RD>, message: string, headers?: Record<string, string>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.mapError(() => new ApiError({ status: 400, message, headers })),
  );

export const decodeQuery = <A, I extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>, RD>(
  schema: Schema.ConstraintCodec<A, I, RD, unknown>,
) => HttpServerRequest.schemaSearchParams(schema).pipe(
  Effect.mapError(() => new ApiError({ status: 400, message: "Invalid query parameters." })),
);

// An error in the OpenAI error format, for the OpenAI-compatible endpoints.
export class OpenAiError extends Data.TaggedError("OpenAiError")<{
  status: number;
  message: string;
  code: string;
  type?: string;
  headers?: Record<string, string>;
}> {
  [HttpServerRespondable.symbol]() {
    const type = this.type ?? (this.status === 429 ? "rate_limit_error" : "server_error");
    return Effect.succeed(HttpServerResponse.jsonUnsafe(
      { error: { message: this.message, type, code: this.code, param: null } },
      { status: this.status, headers: this.headers },
    ));
  }
}
