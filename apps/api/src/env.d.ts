// Secrets are configured with `bunx --no-install wrangler secret put` or in local .dev.vars.
declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    RESEND_API_KEY: string;
    MICROSOFT_CLIENT_ID: string;
    MICROSOFT_CLIENT_SECRET: string;
    MICROSOFT_TENANT_ID: string;
  }
}

interface Env extends Cloudflare.Env {}
