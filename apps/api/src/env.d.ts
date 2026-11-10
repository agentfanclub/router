import type { UserUsage } from "./do/user-usage";

export interface Secrets {
  // Comma separated. Each request uses a random key.
  LUMEN_API_KEYS: string;
  // Optional: unset simply leaves Sarvam unavailable as a club upstream.
  SARVAM_API_KEY?: string;
  // Optional: user-supplied Lumen keys cannot be stored without it.
  BYOK_ENCRYPTION_KEY?: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT_ID: string;
}

export interface ApiEnv extends Secrets {
  DB: D1Database;
  USER_USAGE: DurableObjectNamespace<UserUsage>;
  BETTER_AUTH_URL: string;
  RESEND_FROM_EMAIL: string;
}

// Wrangler generates bindings, but secrets need explicit declarations.
declare global {
  namespace Cloudflare {
    interface Env extends Secrets {}
  }

  interface Env extends Cloudflare.Env {}
}
