# Canopy

An extensible, plugin-driven portal — a slim core with everything else as plugins. The
first app is a **drive** over bring-your-own storage (local filesystem or Cloudflare R2).

Built adapter-first so the same code runs locally on Node and as a single Cloudflare Worker.
Auth is OIDC (authhero). The UI is a Vite + React SPA with a desktop shell and a responsive
mobile shell.

## Layout

```
packages/
  core/                 @canopy/core             interfaces: StorageConnector, PluginRuntime, registry, contributions, plugin sources
  plugin-sources/       @canopy/plugin-sources   resolve plugins from a GitHub folder, npm, or an uploaded zip
  connectors/
    local/              @canopy/connector-local  Node filesystem
    r2/                 @canopy/connector-r2     Cloudflare R2
    github/             @canopy/connector-github read-only; serves the docs + demo drive from a repo
  runtimes/             (planned) sandbox adapters for dynamic plugin code
apps/
  api/                  @canopy/api              portable Hono API — Node entry (node.ts) + Worker entry (worker.ts)
  portal/               @canopy/portal           Vite + React SPA (the Drive UI; desktop + mobile)
examples/
  plugins/              sample plugins — a hook plugin + sandboxed image and PDF viewers
demo/                   sample files for the anonymous demo drive (tracked; runtime data lives in storage/, which is gitignored)
```

## Develop

Requires Node 22 (`.nvmrc`) and pnpm.

```bash
nvm use
pnpm install
pnpm dev        # api on :8787, portal on :5768 (Vite proxies /api → the api)
```

Open <http://localhost:5768>. The browser only talks to 5768; the API is proxied, so it's
same-origin in dev with full HMR.

## Auth (optional)

Without auth configured, the app runs as an anonymous demo. To enable login, copy the
example env and fill in your OIDC issuer + client:

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then edit
```

It uses a confidential or public (PKCE) OIDC client, exchanges the code server-side (BFF),
and stores the session in an encrypted, HttpOnly cookie. Register
`http://localhost:5768/api/auth/callback` as an allowed callback on your client.

## Run as a single process (Node / Docker)

Serve the built UI **and** the API from one Node process on one port:

```bash
pnpm start      # builds the portal, then serves UI + /api on :8787
```

Point the local connector at any folder with `CANOPY_LOCAL_ROOT=/path pnpm start`.

Or with Docker (multi-stage build at the repo root):

```bash
docker build -t canopy .
docker run -p 8787:8787 -v /srv/files:/data canopy   # add -e SESSION_SECRET=… -e OIDC_… for auth
```

## Deploy to Cloudflare

Canopy deploys as a **single Worker**: the API runs on the Worker and the built SPA is
served from Cloudflare **Static Assets**. Storage is **R2** (Workers have no filesystem).
Config is in `apps/api/wrangler.jsonc`.

```bash
# one-time setup
wrangler r2 bucket create canopy-drive
cd apps/api
wrangler secret put OIDC_CLIENT_SECRET     # if your OIDC client is confidential
wrangler secret put SESSION_SECRET         # 32+ random bytes; encrypts the session cookie

# edit apps/api/wrangler.jsonc → set vars.APP_BASE_URL to your deployed URL,
# then register <APP_BASE_URL>/api/auth/callback as a callback on your OIDC client

pnpm deploy        # from the repo root: builds the portal, then `wrangler deploy`
```

`wrangler deploy --dry-run` validates the bundle and bindings without deploying. For the
in-app guide, open the **Docs** plugin → _Deploying_. For the architecture, see
[`docs/02-architecture.md`](docs/02-architecture.md).

## License

MIT
