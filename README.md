# Router

Minimal TypeScript + Effect project for Cloudflare Workers.
The Worker runs an Effect at `/` and returns `hello world`. Other paths return 404.

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

Visit http://localhost:8787/.

```sh
npm run typegen    # Regenerate Cloudflare types after changing bindings/config
npm run typecheck
npm run deploy    # Deploy to your Cloudflare account
```

Reference: [running Effects](https://effect.website/docs/v4/getting-started/running-effects).
