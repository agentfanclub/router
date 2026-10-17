# Router

A Turborepo monorepo using npm workspaces, with two Cloudflare Workers:

- `apps/web`: TanStack Start + React + Tailwind CSS, including server-side rendering and static assets.
- `apps/api`: the Effect API. `/` returns `hello world`; other paths return 404.

The frontend's home page reads the greeting from the API through the `API` service
binding. The browser talks to TanStack Start; its server function calls the API
inside Cloudflare. No API URL or CORS configuration is needed.

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

Visit http://localhost:3000/. The Cloudflare Vite plugin starts both Workers in
the local Workers runtime and connects the service binding. You do not need a
second terminal.

To run just the API, use `npm run dev:api` and visit http://localhost:8787/.

```sh
npm run typegen    # Regenerate both Workers' types after changing bindings/config
npm run build     # Build both apps and generate TanStack's route tree
npm run typecheck
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
