export interface Secrets {
  LUMEN_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT_ID: string;
}

export interface ApiEnv extends Secrets {
  DB: D1Database;
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
