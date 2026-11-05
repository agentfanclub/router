import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { byokKey } from "../db/schema";
import { UserSession, userAuth } from "../middleware/user-auth";
import { encryptSecret } from "../util/secret-box";
import { WorkerEnv } from "../worker-env";

export type ByokKeyRow = Pick<typeof byokKey.$inferSelect, "id" | "label" | "lastFive" | "status" | "createdAt">;

const LUMEN_USAGE_URL = "https://lumen.ncsa.illinois.edu/v1/usage";

// Verifies a candidate key against Lumen before storing it. The cheapest
// authoritative check is the usage endpoint: it authenticates the key and
// confirms it belongs to a real account.
async function verifyWithLumen(key: string): Promise<{ ok: true } | { ok: false; reason: "rejected" | "unreachable" }> {
  try {
    const response = await fetch(LUMEN_USAGE_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (response.ok) return { ok: true };
    return response.status === 401 || response.status === 403
      ? { ok: false, reason: "rejected" }
      : { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export const byokRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/byok/keys", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const keys = yield* Effect.promise(() => drizzle(env.DB)
      .select({
        id: byokKey.id,
        label: byokKey.label,
        lastFive: byokKey.lastFive,
        status: byokKey.status,
        createdAt: byokKey.createdAt,
      })
      .from(byokKey)
      .where(eq(byokKey.userId, session.user.id))
      .orderBy(desc(byokKey.createdAt)),
    );
    return HttpServerResponse.jsonUnsafe(keys satisfies ByokKeyRow[]);
  })),

  HttpRouter.add("POST", "/api/byok/keys", (request) => Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    if (!env.BYOK_ENCRYPTION_KEY) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Personal Lumen keys are not configured on this router." },
        { status: 503 },
      );
    }

    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const record = body as Record<string, unknown> | null;
    const label = typeof record?.label === "string" ? record.label.trim() : "";
    const key = typeof record?.key === "string" ? record.key.trim() : "";
    if (label.length === 0 || label.length > 80) {
      return HttpServerResponse.jsonUnsafe({ error: "Enter a label between 1 and 80 characters." }, { status: 400 });
    }
    if (key.length === 0 || key.length > 4096 || /\s/.test(key)) {
      return HttpServerResponse.jsonUnsafe({ error: "Enter the Lumen API key to add." }, { status: 400 });
    }

    const verification = yield* Effect.promise(() => verifyWithLumen(key));
    if (!verification.ok) {
      return HttpServerResponse.jsonUnsafe(
        verification.reason === "rejected"
          ? { error: "Lumen rejected this key. Check that it is valid and active." }
          : { error: "Unable to reach Lumen to verify this key. Try again." },
        { status: verification.reason === "rejected" ? 400 : 502 },
      );
    }

    const ciphertext = yield* Effect.promise(() => encryptSecret(key, env.BYOK_ENCRYPTION_KEY!));
    const [created] = yield* Effect.promise(() => drizzle(env.DB)
      .insert(byokKey)
      .values({
        id: crypto.randomUUID(),
        userId: session.user.id,
        label,
        ciphertext,
        lastFive: key.slice(-5),
        status: "active",
      })
      .returning({
        id: byokKey.id,
        label: byokKey.label,
        lastFive: byokKey.lastFive,
        status: byokKey.status,
        createdAt: byokKey.createdAt,
      }),
    );
    return HttpServerResponse.jsonUnsafe(created satisfies ByokKeyRow, { status: 201 });
  })),

  HttpRouter.add("DELETE", "/api/byok/keys/:id", Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* UserSession;
    const { id } = yield* HttpRouter.params;
    const db = drizzle(env.DB);
    const deleted = yield* Effect.promise(() => db
      .delete(byokKey)
      .where(and(eq(byokKey.id, id!), eq(byokKey.userId, session.user.id)))
      .returning({ id: byokKey.id }),
    );
    if (deleted.length === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "Key not found." }, { status: 404 });
    }
    return HttpServerResponse.jsonUnsafe({ success: true });
  })),
).pipe(Layer.provide(userAuth));
