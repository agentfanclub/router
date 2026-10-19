// Secrets are configured with `wrangler secret put` or in local .dev.vars.
interface Env {
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
}
