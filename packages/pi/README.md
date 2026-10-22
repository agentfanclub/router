# Agent Fan Club for Pi and Oh My Pi

One package provides the `agentfanclub` provider in both clients. Pi reads the
`pi` manifest and Oh My Pi reads the `omp` manifest. The entry points share device
sign-in and model discovery, with a small adapter for each client's provider API.

From this repository, load the extension for one invocation:

```sh
# Pi
pi -e ./packages/pi/src/index.ts

# Oh My Pi
omp -e ./packages/pi/src/omp.ts
```

For a persistent local install, use `pi install ./packages/pi` or
`omp plugin install ./packages/pi`. Restart the client after installing.
The npm package name is `@agentfanclub/pi`. Install it with
`pi install npm:@agentfanclub/pi` or `omp plugin install @agentfanclub/pi`.
Browser sign-in requires the device-authorization API and web routes to be deployed.

Run `/login`, select **Agent Fan Club**, open the browser link, compare the code,
and approve. Then use `/model` to select an Agent Fan Club model. The client saves
the dedicated API key in its own credential store. Neither the key nor the
private device secret appears in the browser URL.

The approval page and API Keys entry identify the client as Pi or Oh My Pi.
Disable or delete that key on the website to revoke access. `/logout` only removes
the locally saved credential. The key does not expire and needs no token refresh.

The extension fetches `/api/models` with the saved credential and uses the host's
OpenAI Chat Completions transport at `/inference/v1`. Model discovery refreshes
through each client's native discovery hook. Names, limits, modalities, reasoning
support, and costs per million tokens come from the API catalog. Cache reads use
the input price, and cache writes cost zero.

For local development, run the API and web app, apply the D1 migrations, and set
`BETTER_AUTH_URL` in the API's `.dev.vars` to the web origin. Point the extension
at the API origin when starting the client:

```sh
AGENTFANCLUB_API_URL=http://localhost:8787 pi -e ./packages/pi/src/index.ts
AGENTFANCLUB_API_URL=http://localhost:8787 omp -e ./packages/pi/src/omp.ts
```

Credentials are tied to the API origin. Sign in again after changing it.
HTTPS is required except on loopback addresses.

Typechecked against Pi 1.3.0 and Oh My Pi 18.12.3. The package imports their SDKs
only for types, so it does not bundle either client or require both at runtime.
