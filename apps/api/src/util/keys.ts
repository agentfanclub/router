import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { apiKey, deviceAuthorization } from "../db/schema";

export const publicApiKeyFields = {
  id: apiKey.id,
  name: apiKey.name,
  lastFive: apiKey.lastFive,
  enabled: apiKey.enabled,
  createdAt: apiKey.createdAt,
};

export function generateApiKey() {
  const token = `sk-afcrouter-${randomBytes(32).toString("hex")}`;
  const now = new Date();
  return {
    token,
    values: {
      id: crypto.randomUUID(),
      hash: createHash("sha256").update(token).digest("hex"),
      lastFive: token.slice(-5),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function createApiKey({ db, userId, name }: {
  db: ReturnType<typeof drizzle>;
  userId: string;
  name: string;
}) {
  const { token, values } = generateApiKey();
  const [key] = await db.insert(apiKey)
    .values({ ...values, userId, name })
    .returning(publicApiKeyFields);
  return { key, token };
}

export async function createDeviceApiKey({ db, deviceCodeHash, name }: {
  db: ReturnType<typeof drizzle>;
  deviceCodeHash: string;
  name: string;
}) {
  const { token, values } = generateApiKey();
  // Create the key and consume the approval atomically so it can only be redeemed once.
  const [created] = await db.batch([
    db.insert(apiKey).select(db.select({
      id: sql`${values.id}`.as("id"),
      userId: deviceAuthorization.userId,
      name: sql`${name}`.as("name"),
      hash: sql`${values.hash}`.as("hash"),
      lastFive: sql`${values.lastFive}`.as("lastFive"),
      enabled: sql`${Number(values.enabled)}`.as("enabled"),
      createdAt: sql`${values.createdAt.getTime()}`.as("createdAt"),
      updatedAt: sql`${values.updatedAt.getTime()}`.as("updatedAt"),
    }).from(deviceAuthorization).where(and(
      eq(deviceAuthorization.deviceCodeHash, deviceCodeHash),
      eq(deviceAuthorization.status, "approved"),
      isNotNull(deviceAuthorization.userId),
      gt(deviceAuthorization.expiresAt, values.createdAt),
    ))).returning({ id: apiKey.id }),
    db.delete(deviceAuthorization).where(and(
      eq(deviceAuthorization.deviceCodeHash, deviceCodeHash),
      eq(deviceAuthorization.status, "approved"),
    )),
  ]);

  return created.length ? token : null;
}
