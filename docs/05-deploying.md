# Deploying

Canopy ships as a **single process** — the API and the bundled UI run together, served from
one origin. There are two targets, and both reuse the same portable Hono app (`apps/api/src/app.ts`):

- **Cloudflare** (the primary target) — one Worker serves the API; the built SPA is served
  from Cloudflare **Static Assets**; storage is **R2**.
- **Node / Docker** — one Node process serves the built SPA and the API on one port; storage
  is the local filesystem.

> Dev is different on purpose: `pnpm dev` runs Vite (port 5768, with HMR) and proxies `/api`
> to the API process (8787). The browser sees a single origin, but it's two dev processes.
> The single-process modes below are for shipping.

## Cloudflare (single Worker + Static Assets)

The Worker entry is `apps/api/src/worker.ts`; configuration is `apps/api/wrangler.jsonc`. The
key bits:

- `assets.directory: "../portal/dist"` — the built SPA is uploaded as static assets.
- `not_found_handling: "single-page-application"` — unmatched paths fall back to `index.html`.
- `run_worker_first: ["/api/*"]` — the Worker handles the API; everything else is served
  straight from the asset store, so the Worker isn't even invoked for static files.
- `r2_buckets` — the `BUCKET` binding is the user's drive. Workers have no filesystem, so
  storage on Cloudflare is always R2 (the local connector is Node-only).

### Deploy steps

```bash
# 1. Create the R2 bucket for the drive
wrangler r2 bucket create canopy-drive

# 2. Set secrets (run from apps/api)
wrangler secret put OIDC_CLIENT_SECRET   # only if your OIDC client is confidential
wrangler secret put SESSION_SECRET       # 32+ random bytes; encrypts the session cookie

# 3. In apps/api/wrangler.jsonc, set vars.APP_BASE_URL to your deployed URL, and
#    register <APP_BASE_URL>/api/auth/callback as an allowed callback on the OIDC client.

# 4. Build the SPA and deploy the Worker (from the repo root)
pnpm deploy
```

`pnpm deploy` runs `vite build` for the portal and then `wrangler deploy`. To validate the
bundle and bindings without shipping:

```bash
cd apps/api && wrangler deploy --dry-run
```

### Notes

- **Docs + demo come from GitHub.** Set `GITHUB_REPO` (e.g. `owner/repo`, optional
  `GITHUB_BRANCH`, and `GITHUB_TOKEN` for a private repo) and the read-only **docs** mount and
  the **anonymous demo drive** are read live from the repo via `@canopy/connector-github` — no
  files bundled, no R2 bucket for them. Unset (dev), they fall back to the in-repo `docs/` and
  `demo/` folders. Signed-in users' drives are the real connector (local FS / R2).
- **`wrangler dev`** (the local Cloudflare runtime) needs `workerd`, whose native build pnpm
  blocks by default — run `pnpm approve-builds` once if you want it. `wrangler deploy` does
  not need it. For day-to-day work, prefer `pnpm dev`.

## Node / Docker (single process)

```bash
pnpm start
```

This builds the portal, then runs `apps/api` which detects `apps/portal/dist` and serves the
SPA (with SPA fallback) **and** `/api` on one port (`:8787`). Point the drive at any folder:

```bash
CANOPY_LOCAL_ROOT=/srv/files pnpm start
```

A `Dockerfile` at the repo root does this in a multi-stage build (install + `vite build`,
then run the API serving `dist` + `/api`):

```bash
docker build -t canopy .
docker run -p 8787:8787 \
  -v /srv/files:/data \
  -e SESSION_SECRET=... -e OIDC_ISSUER=... -e OIDC_CLIENT_ID=... -e OIDC_CLIENT_SECRET=... \
  canopy
```

The drive's storage root is the `/data` volume (`CANOPY_LOCAL_ROOT`). Auth env vars (see
`apps/api/.dev.vars.example`) are passed at runtime — secrets are never baked into the image
(`.dev.vars` is in `.dockerignore`). The image has a healthcheck on `/api/health`.

## A note on auth callbacks

The OIDC redirect URI is derived from `APP_BASE_URL` — so it differs per environment
(`http://localhost:5768/api/auth/callback` in dev, `https://your-domain/api/auth/callback` in
production). Each one must be registered as an allowed callback on your OIDC client, or login
fails with a `redirect_uri` mismatch.
