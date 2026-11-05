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
and new accounts. Admins can open the Admin tab to view all users and their roles,
plus cumulative Lumen usage, coin spend, available coins, and the last-used time.
`GET /api/admin/users` and `GET /api/admin/lumen-usage` require an admin session.
Lumen usage is for the router's shared `LUMEN_API_KEY`; the available coin balance
is shared across its owning Lumen account. Roles cannot be set through sign-in
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
bunx --no-install wrangler secret put BYOK_ENCRYPTION_KEY
```

`BYOK_ENCRYPTION_KEY` is any random string of at least 32 characters; it
encrypts users' personal Lumen keys (AES-GCM) before they are stored. Without
it, users cannot add personal keys, and inference works as before. Rotating it
invalidates every stored personal key.

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

## Inference forwarding

The API exposes `POST /inference/v1/chat/completions`, forwarding
to [Lumen](https://lumen.ncsa.illinois.edu/help/api). Set `LUMEN_API_KEY` in
`apps/api/.dev.vars` locally. For production, set the API Worker's secret:

```sh
cd apps/api
bunx --no-install wrangler secret put LUMEN_API_KEY
```

Configure OpenAI-compatible clients with the base URL
`https://api.router.agentfan.club/inference/v1`, or `http://localhost:8787/inference/v1` when running
the standalone API locally. Use an enabled key created in the router's API Keys
page as the client API key. Missing, invalid, deleted, and disabled keys return
401. The router checks the key on every request, resolves the user and their
usage limits, and sends its own Lumen key upstream. Model IDs must be in the
local catalog in `apps/api/src/data/models.json`; unknown models return 404
with the available list. `GET /api/models` serves the catalog using the same
bearer API key authentication (or a website session). It does not contact
Lumen or require `LUMEN_API_KEY`. The catalog is a map keyed by Lumen model ID,
following the [models.dev format](https://models.dev/models.json) with names,
limits, costs per million tokens, modalities, and capability flags. Update
that JSON file to change the available model list.

Request bodies are read and parsed by the worker so requests can be priced and
session-tagged before forwarding. The router derives a stable session ID by
prefixing `ses_` to a hash of the system prompt and first user message, independent of client session
headers. Identical initial prompts share a tag; these tags are grouping hints,
not unique conversation identifiers. The assigned tag is exposed on
responses as `x-router-session`. On streaming requests where the client did
not ask for usage, the router injects `stream_options.include_usage` upstream
and strips the extra usage-only chunk from the client's stream; real token
counts back the cost accounting. Legacy completions, audio, and other Lumen
endpoints are not exposed.

## Usage limits and logging

Each user's inference spend is capped by two tumbling cost windows: **$10 per
five hours and $50 per week** by default, anchored at the first request after
the previous window expires, the same shape as subscription plans. Costs are
integer micro-dollars computed from the model catalog's per-million-token
prices, with cached input tokens priced at the cache-read rate.

Enforcement lives in one `UserUsage` Durable Object per user (the `USER_USAGE`
binding), which owns these records in its SQLite storage:

- **Windows** — `(start, used)` counters per window. Windows advance only on
  traffic: the first admission after a window expires re-anchors it to that
  request, so an idle user keeps a spent budget until they return. The alarm
  never resets windows, and reading usage never starts one — an expired window
  is reported as empty and "resetting now" until the next admission consumes
  the reset.
- **Reservations** — admitted requests reserve an estimated cost (input
  estimate from body size plus `max_tokens` at the model's output price) for
  15 minutes. Concurrent requests, such as parallel coding-agent calls, cannot
  jointly reserve more than a window allows. Expired reservations are released
  and recorded as aborted with unknown usage and zero spend. Late reported usage is charged in the original
  windows, without charging a new window after a reset.
- **Request journal** — metadata is saved at admission, so pending and interrupted
  requests remain visible. Settlement updates the journal and allowance counters
  in one SQLite transaction. D1 receives an idempotent copy; failed writes stay
  queued for an alarm retry. On upgrade, historical charges with estimated costs
  and no token usage are cleared in both the journal and D1, and allowance
  counters are rebuilt. Reservations without request metadata are released.
- **Session routes** — the last upstream per session tag, keeping prompt-cache
  affinity when more upstreams are added.

The worker calls the object twice per request: `admit` before forwarding
(returns the route and reservation, or a denial with reset timing) and
`settle` after the response completes. Only reported token usage is charged;
responses without usage record zero spend. The `estimated` flag marks unknown
usage on non-error responses, including interrupted streams. Stream terminal events
settle before being forwarded, and the stream pump and settlement use
`waitUntil` so client disconnects do not discard accounting. Settle is idempotent
per request ID. If the object is unreachable,
requests fail closed with 503 rather than bypassing limits. When a cap is
hit, clients receive a 429 `rate_limit_error` with a human-readable message,
a `Retry-After` header, and both windows in the body.

Every request — served, denied, failed, or aborted — is recorded in the
`usage_log` D1 table with the user, API key, session tag, model, token counts,
cost, status, and duration. Rows are keyed by request ID, so retried inserts
cannot double-log. Prompt and completion bodies are never stored. The Logs
page groups requests into one row per session, with model filters; the
Overview page shows live window meters, in-flight reservations, and daily
spend; the Admin page adds per-user and per-model spend with daily charts.

Per-user limit overrides live in the `usage_limit` table
(`PUT /api/admin/users/:id/limits`, editable in the Admin page); null columns
fall back to the defaults. Apply the D1 migration before deploying:

```sh
bun run --filter @router/api db:migrate:local
# For a release, apply the remote migration before deploying the API:
# bun run --filter @router/api db:migrate:remote
```

The Durable Object class is SQLite-backed (`new_sqlite_classes` migration in
`apps/api/wrangler.jsonc`); Wrangler applies the class migration on the first
deploy that includes it.

### Inference diagnostics

Cloudflare Workers Logs and automatic traces are enabled at 100% sampling in
`apps/api/wrangler.jsonc`. In the Cloudflare dashboard, open `router-api` →
Observability to search stored events or inspect upstream fetch spans. Logs
start when enabled; they do not recover past failures.

Inference responses after admission include `x-router-request-id`, matching
the D1 usage record ID and the structured logs' `requestId`. Filter by that
field to follow `upstream_started`, `upstream_response`, and
`inference_finished` events. Upstream responses record HTTP status, time to
response headers (`headersMs`), attempt number, route, and upstream request/Ray
IDs when available. Failovers log both attempts. Separate error events identify
HTTP errors, fetch failures, JSON/SSE errors, interrupted streams, and settlement
failures. An HTTP 200 can still contain a JSON or SSE error.

Diagnostic events exclude prompts, completions, credentials, and raw error
messages/bodies. Only short machine error codes/types are retained. Query
strings are redacted from Cloudflare invocation logs and traces. These events
live in Cloudflare, not D1; historical usage rows retain their existing fields.

## Personal Lumen keys

Users can add their own Lumen API keys from the API Keys page. A personal
key is a fallback upstream with the lowest routing priority: the coordinator
sends a request to it only when the club's shared allowance cannot serve —
the five-hour or weekly cap is exhausted, or the shared Lumen account answers
with an auth, payment, or quota error (401/402/429), in which case the router
retries the request on the personal key immediately and the client never sees
the first failure. Spend on a personal key is not capped by the club; it is
logged and shown separately as personal spend on the Overview sparkline, the
Logs page, and the Admin per-user table.

Keys are verified against Lumen before they are stored, encrypted with
AES-GCM under the `BYOK_ENCRYPTION_KEY` secret, and only decrypted when a
request is actually routed to them. D1 stores ciphertext only. When Lumen
rejects a personal key during a request (401/403), the router marks it
invalid and later requests move on to the user's next active key or back to
the shared account. A mid-request failover releases the club reservation
without charging the allowance. Managing keys requires a website session;
the endpoints are `GET/POST /api/byok/keys` and `DELETE /api/byok/keys/:id`.

Later additions are designed for but not yet built: the club's OpenCode Go
allocation as a second club upstream when the shared Lumen balance runs dry,
and a shared club-state observation row so the coordinator can prefer healthy
upstreams before the first failure. The admit/settle interface already
accepts upstream availability and per-route prices, so these arrive as new
inputs rather than protocol changes.

## Coding agent connections

`packages/opencode` registers Agent Fan Club as an OpenCode v2 provider with the ID `agentfanclub`. Its browser
sign-in method opens `/connect/opencode`, where a signed-in user compares the
code with their terminal and approves or declines. Illinois sign-in, email links,
and email codes return to the approval page.

`packages/pi` provides the same `agentfanclub` provider for Pi and Oh My Pi.
Both clients use `/login` and discover models through `/api/models`. See
[Pi and Oh My Pi setup](packages/pi/README.md).

Apply the new D1 migrations before using the device flow:

```sh
bun run --filter @router/api db:migrate:local
# For a release, apply the remote migration before deploying the API:
# bun run --filter @router/api db:migrate:remote
```

`POST /api/device/code` accepts a JSON `client` of `opencode`, `pi`, or `oh-my-pi`.
It starts a 10-minute request and returns a device secret,
a verification URL, and a public code. The plugin polls `POST /api/device/token`
every 5 seconds. Approval requires a website session and a same-origin request.
The first successful exchange creates a dedicated key named for the client and consumes
the request atomically. The browser never receives the API key. Expired device
requests are removed when a new request starts.

Users can revoke the key from API Keys. Disconnecting in OpenCode only removes
its local credential. See [plugin setup](packages/opencode/README.md) for local
configuration. This flow has not been deployed or included in a new npm release.

## Missing pages

Unmatched frontend URLs return HTTP 404 and show the route-the-packet game.
Puzzles are generated in the browser after hydration, with no API calls or
persisted game state. The generator creates a solvable path, adds decoy pipes,
and scrambles tile rotations. Difficulty is an estimate based on path length,
turns, and the rotations needed for the generated solution.

Run `bun run --filter @router/web test` to check route generation, hints,
difficulty coverage, and connectivity.
