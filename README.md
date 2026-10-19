# Router

A Turborepo monorepo using npm workspaces, with two Cloudflare Workers:

- `apps/web`: TanStack Start + React + Tailwind CSS, including server-side rendering and static assets.
- `apps/api`: the Effect API and Better Auth, backed by Drizzle and Cloudflare D1.

The frontend proxies `/api/auth/*` to the API through its `API` service binding.
Auth cookies stay on the frontend origin, and server-rendered pages read the same
session. `/` requires a session and redirects signed-out users to `/login`.
The login form accepts a NetID with a fixed `@illinois.edu` suffix. The API also
rejects other domains, subdomains, and email aliases. Both sign-in methods create
an account on first use after the user proves email ownership.

Requires Node.js 22.12 or newer.

```sh
npm install
cp apps/api/.env.example apps/api/.dev.vars
# Set the values in .dev.vars before starting.
npm run db:migrate:local -w @router/api
npm run dev
```

Set `BETTER_AUTH_SECRET` to a random value of at least 32 characters,
`RESEND_API_KEY` to your Resend API key, and `RESEND_FROM_EMAIL` to an address on
a domain verified in Resend. Keep `BETTER_AUTH_URL=http://localhost:3000` locally.
`.dev.vars` is ignored by Git. The example contains placeholders, not working credentials.

Visit http://localhost:3000/. The Cloudflare Vite plugin starts both Workers in
the local Workers runtime and connects the service binding. You do not need a
second terminal. Vite and standalone Wrangler share the API's
`apps/api/.wrangler/state` directory so both use the same local D1 database.

To run just the API, use `npm run dev:api` and visit http://localhost:8787/.
For direct auth testing on that port, set `BETTER_AUTH_URL=http://localhost:8787`
in `.dev.vars`; restore port 3000 when using the frontend.

```sh
npm run typegen    # Regenerate both Workers' types after changing bindings/config
npm run build     # Build both apps and generate TanStack's route tree
npm run typecheck
npm test          # Auth integration tests with local D1 and mocked Resend
npm run deploy    # Deploy the API first, then build and deploy the frontend
```

Turborepo runs and caches builds and typechecks. Typechecking builds first to
generate TanStack's route tree. The frontend build depends on the API build
because the Cloudflare Vite plugin includes the API as an auxiliary Worker.
Cached frontend builds also restore Wrangler's deployment configuration.

`npm run dev` runs the frontend's persistent Turbo task, which starts both Workers
through Vite. `npm run dev:api` starts only the API. Deploy and type generation
tasks always run. Use the root deploy commands so Turbo builds before deploying.

Tailwind uses `@tailwindcss/vite` and `apps/web/src/styles.css`. Add utility classes
directly to React components; no Tailwind configuration file is needed.

The Worker names are `router-api` and `router-web`, configured in each app's
`wrangler.jsonc`. Their custom domains are https://router.agentfan.club for the
frontend and https://api.router.agentfan.club for the API. Wrangler manages the
custom domain DNS records and certificates. The `workers.dev` URLs also remain enabled.
Deployment requires a Cloudflare account and Wrangler login.
For separate releases, use `npm run deploy:api` or `npm run deploy:web`. Deploy
the API before the frontend on the first release so its service binding resolves.

`worker-configuration.d.ts` files and `apps/web/src/routeTree.gen.ts` are generated.
Keep them in version control; regenerate rather than editing them by hand.
Turbo's typecheck task builds first, so newly added routes are included automatically.

References: [Turborepo tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
[Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite),
[TanStack Start on Cloudflare](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/),
[auxiliary Workers](https://developers.cloudflare.com/changelog/post/2026-01-20-auxiliary-workers/),
and [running Effects](https://effect.website/docs/v4/getting-started/running-effects).

## Authentication and database

Better Auth provides magic links and 6-digit email codes. Both expire after
5 minutes and are stored as hashes. Codes allow 5 verification attempts. Auth
rate limits persist in D1 across Worker instances. Resend delivery errors return
a failure to the form. No passwords or social providers are enabled.

The D1 database `router-db` is bound as `DB` on the API Worker. Its initial
migration has been applied locally and remotely. Drizzle schema files live in
`apps/api/src/db/schema.ts`; commit the generated SQL and snapshots after changes.

```sh
npm run db:generate -w @router/api
npm run db:migrate:local -w @router/api
npm run db:migrate:remote -w @router/api
```

Before deploying auth, set the API Worker's secrets:

```sh
cd apps/api
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put RESEND_API_KEY
```

Set `RESEND_FROM_EMAIL` in `apps/api/wrangler.jsonc` to a verified Resend sender.
Production `BETTER_AUTH_URL` is `https://router.agentfan.club`, the public frontend
origin. Change it with the frontend domain. Auth is served through that origin;
the API's standalone domain does not need its own browser cookies or CORS policy.

Tests cover both sign-in methods, session lookup and sign-out, token reuse and
expiry, Illinois-only email validation, delivery failures, origin and redirect
checks, and database-backed rate limiting. They do not send real emails.

References: [Better Auth magic links](https://better-auth.com/docs/plugins/magic-link),
[email OTP](https://better-auth.com/docs/plugins/email-otp),
[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), and
[Resend email delivery](https://resend.com/docs/send-with-nodejs).
