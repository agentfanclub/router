# Router

A Turborepo monorepo using Bun workspaces, with two Cloudflare Workers:

- `apps/web`: TanStack Start + React + Tailwind CSS, including server-side rendering and static assets.
- `apps/api`: Effect HTTP routing and Better Auth, backed by Drizzle and Cloudflare D1.

Effect's `HttpRouter` handles API routes in `apps/api/src/index.ts`.
`HttpRouter.toWebHandler` builds the application once at module scope and adapts
it to the Worker's `fetch` handler. Better Auth is called through `Effect.promise`
at `/api/auth/*`, using the Worker's bindings from `cloudflare:workers`.

The frontend proxies `/api/auth/*` to the API through its `API` service binding.
Auth cookies stay on the frontend origin, and server-rendered pages read the same
session. `/` requires a session and redirects signed-out users to `/login`.
The login form accepts a NetID with a fixed `@illinois.edu` suffix. The API also
rejects other domains, subdomains, and email aliases. Both sign-in methods create
an account on first use after the user proves email ownership.

Requires Bun 1.3.12 or newer and Node.js 22.12 or newer. Cloudflare tooling
uses Node.js.

```sh
bun install
cp apps/api/.env.example apps/api/.dev.vars
# Set the values in .dev.vars before starting.
bun run --filter @router/api db:migrate:local
bun run dev
```

Set `BETTER_AUTH_SECRET` to a random value of at least 32 characters,
`RESEND_API_KEY` to your Resend API key, and `RESEND_FROM_EMAIL` to an address on
a domain verified in Resend. Keep `BETTER_AUTH_URL=http://localhost:3000` locally.
Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, and `MICROSOFT_CLIENT_SECRET`
for Illinois sign-in. The Azure app is restricted to the university tenant.
`bun install --frozen-lockfile` installs the committed dependency versions in CI.
`.dev.vars` is ignored by Git. The example contains placeholders, not working credentials.

Visit http://localhost:3000/. The Cloudflare Vite plugin starts both Workers in
the local Workers runtime and connects the service binding. You do not need a
second terminal. Vite and standalone Wrangler share the API's
`apps/api/.wrangler/state` directory so both use the same local D1 database.

To run just the API, use `bun run dev:api` and visit http://localhost:8787/.
For direct auth testing on that port, set `BETTER_AUTH_URL=http://localhost:8787`
in `.dev.vars`; restore port 3000 when using the frontend.

```sh
bun run typegen    # Regenerate both Workers' types after changing bindings/config
bun run build      # Build both apps and generate TanStack's route tree
bun run typecheck
bun run --filter @router/web test  # Puzzle generation and route validation
bun run deploy     # Deploy the API first, then build and deploy the frontend
```

Turborepo runs and caches builds and typechecks. Typechecking builds first to
generate TanStack's route tree. The frontend build depends on the API build
because the Cloudflare Vite plugin includes the API as an auxiliary Worker.
Cached frontend builds also restore Wrangler's deployment configuration.

`bun run dev` runs the frontend's persistent Turbo task, which starts both Workers
through Vite. `bun run dev:api` starts only the API. Deploy and type generation
tasks always run. Use the root deploy commands so Turbo builds before deploying.

Tailwind uses `@tailwindcss/vite` and `apps/web/src/styles.css`. Add utility classes
directly to React components; no Tailwind configuration file is needed.

The Worker names are `router-api` and `router-web`, configured in each app's
`wrangler.jsonc`. Their custom domains are https://router.agentfan.club for the
frontend and https://api.router.agentfan.club for the API. Wrangler manages the
custom domain DNS records and certificates. The `workers.dev` URLs also remain enabled.
Deployment requires a Cloudflare account and Wrangler login.
For separate releases, use `bun run deploy:api` or `bun run deploy:web`. Deploy
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
5 minutes and are stored as hashes. One sign-in email contains both a link and
a 6-digit code. The next screen lets you click the emailed link or enter the code.
Emailed links open a confirmation page and redeem the token only when the user
presses "Sign in", so a scanner fetching the page does not consume the link.
Codes allow 5 verification attempts. Request rate limiting is disabled. Resend
delivery errors return a failure to the form. Only magic link and OTP sign-in endpoints and session
lookup/sign-out are exposed. A successful first sign-in automatically creates
the user. There is no separate signup, email verification, or password flow.

The schema retains Better Auth's required core tables and fields. `verification`
stores the expiring magic link and OTP hashes. `emailVerified` records proof from
sign-in; it does not require another email. The `account` table and its password
and OAuth fields remain for Better Auth schema compatibility, but neither login
method creates an account row or stores a password.

The D1 database `router-db` is bound as `DB` on the API Worker. Its initial
migration has been applied locally and remotely. Drizzle schema files live in
`apps/api/src/db/schema.ts`; commit the generated SQL and snapshots after changes.

```sh
bun run --filter @router/api db:generate
bun run --filter @router/api db:migrate:local
bun run --filter @router/api db:migrate:remote
```

Users have a `role` of `admin` or `user`, with `user` as the default for existing
and new accounts. Admins can open the Users tab to view all users and their roles.
The API also restricts this list to admins. Roles cannot be set through sign-in
requests. To grant admin access, update the account directly in D1 after applying
the migrations:

```sh
cd apps/api
bunx --no-install wrangler d1 execute DB --local --command "UPDATE user SET role = 'admin' WHERE email = 'your-netid@illinois.edu';"
```

Use `--remote` instead of `--local` for the deployed database.

Before deploying auth, set the API Worker's secrets:

```sh
cd apps/api
bunx --no-install wrangler secret put BETTER_AUTH_SECRET
bunx --no-install wrangler secret put RESEND_API_KEY
bunx --no-install wrangler secret put MICROSOFT_CLIENT_ID
bunx --no-install wrangler secret put MICROSOFT_TENANT_ID
bunx --no-install wrangler secret put MICROSOFT_CLIENT_SECRET
```

Set `RESEND_FROM_EMAIL` in `apps/api/wrangler.jsonc` to a verified Resend sender.
Production `BETTER_AUTH_URL` is `https://router.agentfan.club`, the public frontend
origin. Change it with the frontend domain. Auth is served through that origin;
the API's standalone domain does not need its own browser cookies or CORS policy.

The Azure app's Web redirect URIs are
`https://router.agentfan.club/api/auth/callback/microsoft` and
`http://localhost:3000/api/auth/callback/microsoft`.
Microsoft sign-in uses the university NetID sign-in name and a stable Microsoft
account ID. A validated university token with an Illinois NetID sign-in name is
treated as email-verified. Sign-in automatically links to an existing account
with the same verified email; unverified local accounts are not automatically linked.

References: [Better Auth magic links](https://better-auth.com/docs/plugins/magic-link),
[email OTP](https://better-auth.com/docs/plugins/email-otp),
[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), and
[Resend email delivery](https://resend.com/docs/send-with-nodejs).

## Missing pages

Unmatched frontend URLs return HTTP 404 and show the route-the-packet game.
Puzzles are generated in the browser after hydration, with no API calls or
persisted game state. The generator creates a solvable path, adds decoy pipes,
and scrambles tile rotations. Difficulty is an estimate based on path length,
turns, and the rotations needed for the generated solution.

Run `bun run --filter @router/web test` to check route generation, hints,
difficulty coverage, and connectivity.
