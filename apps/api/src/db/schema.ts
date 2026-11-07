import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DeviceClient } from "../device-clients";

export const userRoles = ["admin", "user"] as const;

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
};

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role", { enum: userRoles }).notNull().default("user"),
  ...timestamps,
}, (table) => [check("user_role_check", sql`${table.role} in ('admin', 'user')`)]);

export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hash: text("hash").notNull().unique(),
  lastFive: text("last_five").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [index("api_key_user_id_idx").on(table.userId)]);

export const deviceAuthorization = sqliteTable("device_authorization", {
  deviceCodeHash: text("device_code_hash").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  client: text("client").$type<DeviceClient>().notNull().default("opencode"),
  status: text("status", { enum: ["pending", "approved", "denied"] }).notNull().default("pending"),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  nextPollAt: integer("next_poll_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("device_authorization_expires_at_idx").on(table.expiresAt)]);

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  ...timestamps,
}, (table) => [index("session_user_id_idx").on(table.userId)]);

// Stores linked sign-in providers for Better Auth.
export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  ...timestamps,
}, (table) => [index("account_user_id_idx").on(table.userId)]);

// One completed, denied, or failed inference request. The request ID is the
// primary key so worker retries after a transient D1 error cannot double-log.
// Costs are integer micro-dollars. Prompt and completion bodies are never stored.
export const usageUpstreams = ["lumen", "byok", "sarvam"] as const;
export const usageBilled = ["club", "personal"] as const;
export const usageStatuses = ["pending", "ok", "error", "aborted", "denied"] as const;

export const usageLog = sqliteTable("usage_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  // Plain text without a foreign key: keys can be deleted, history should not be.
  apiKeyId: text("api_key_id"),
  sessionId: text("session_id"),
  model: text("model").notNull(),
  upstream: text("upstream", { enum: usageUpstreams }).notNull(),
  billed: text("billed", { enum: usageBilled }).notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedTokens: integer("cached_tokens"),
  costMicro: integer("cost_micro").notNull(),
  estimated: integer("estimated", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: usageStatuses }).notNull(),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("usage_log_user_created_idx").on(table.userId, table.createdAt),
  index("usage_log_session_idx").on(table.sessionId),
  index("usage_log_created_idx").on(table.createdAt),
]);

// Per-user overrides of the default usage caps. Null columns fall back to the defaults.
export const usageLimit = sqliteTable("usage_limit", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  fiveHourMicro: integer("five_hour_micro"),
  weeklyMicro: integer("weekly_micro"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});

// A user's own Lumen API key. The key itself is AES-GCM encrypted under the
// worker's BYOK_ENCRYPTION_KEY secret; only the ciphertext is stored. Active
// keys are a fallback upstream when the club's shared allowance cannot serve.
export const byokKeyStatuses = ["active", "invalid"] as const;

export const byokKey = sqliteTable("byok_key", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  ciphertext: text("ciphertext").notNull(),
  lastFive: text("last_five").notNull(),
  status: text("status", { enum: byokKeyStatuses }).notNull().default("active"),
  ...timestamps,
}, (table) => [index("byok_key_user_idx").on(table.userId, table.status)]);

// Stores expiring sign-in links and OTP hashes, not a separate verification flow.
export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ...timestamps,
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);
