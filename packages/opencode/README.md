# Agent Fan Club OpenCode plugin

Registers Agent Fan Club as an OpenCode v2 provider. Run `/connect`, select Agent Fan Club, and
choose "Sign in to Agent Fan Club". Open the authorization URL, sign in with your Illinois
account, compare the code with your terminal, and approve the connection.

The plugin, provider, and integration ID is `agentfanclub`.

The plugin receives a dedicated API key and OpenCode saves it in its credential
store. It discovers models through `GET /api/models` and sends chat requests to
`/inference/v1/chat/completions`. Use `/models` to select a Agent Fan Club model.

The device request expires after 10 minutes. The API key stays valid until you
disable or delete it from Agent Fan Club's API Keys page, where it is named "OpenCode".
Removing the saved account from OpenCode does not revoke the server-side key.
If the connection is interrupted after approval, revoke the unused key and retry.

The implementation is in `src/index.ts`; the root `index.ts` lets OpenCode load
the local package directory. OpenCode loads TypeScript directly, so no build
step is needed. This implementation is local; the published `0.0.1` package is
still the empty starter until a new version is released.

From the repository root:

```sh
bun install
bun run --filter @agentfanclub/opencode typecheck
```

Load this worktree's plugin from a repository-root `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./packages/opencode"]
}
```

Paths are relative to the config file. For a global config or another project,
use the absolute path to this package instead.

To use a local API, pass its origin in plugin options:

```json
{
  "plugins": [
    {
      "package": "./packages/opencode",
      "options": { "apiUrl": "http://localhost:8787" }
    }
  ]
}
```

Run the API on port 8787 and the web app on port 3000. Set `BETTER_AUTH_URL` to
`http://localhost:3000` in the API's `.dev.vars`; it determines the approval URL.
The plugin accepts HTTPS origins and HTTP loopback origins. Credentials are tied
to that origin, so changing it requires a new connection.

The plugin uses OpenCode's OAuth browser method for the device exchange. The
stored access token is a Agent Fan Club API key, with no expiry or refresh token. Device
secrets and API keys never appear in browser URLs. D1 stores only their hashes,
and redemption creates the API key and consumes the request in one transaction.

Model discovery reads the catalog's names, context and output limits, costs per
million tokens, modalities, and tool support. It refreshes on startup and credential
changes.

See the [OpenCode v2 plugin documentation](https://opencode.ai/v2/docs/build/plugins/).
