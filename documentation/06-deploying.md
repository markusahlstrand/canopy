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

The Worker entry is `apps/api/src/worker.ts`; configuration is `apps/api/wrangler.jsonc`. That
file is **gitignored** because it holds your own D1 `database_id` (which points at your
Cloudflare account) — copy the tracked template to create it:

```bash
cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
```

The key bits:

- `assets.directory: "../portal/dist"` — the built SPA is uploaded as static assets.
- `not_found_handling: "single-page-application"` — unmatched paths fall back to `index.html`.
- `run_worker_first: ["/api/*", "/dav/*"]` — the Worker handles the API and WebDAV; everything
  else is served straight from the asset store, so the Worker isn't even invoked for static files.
- `d1_databases` — the `DB` binding holds the drive's metadata (files, versions, blob
  refcounts, permissions). The schema is applied by a migration runner on first request.
- `r2_buckets` — the `BUCKET` binding holds the content-addressed **blobs**. Workers have no
  filesystem, so on Cloudflare the drive is always D1 + R2 (the libsql/fs adapters are Node-only).

### Config: tracked template, gitignored copy

Canopy is open source, so the committed config can't carry one deployment's account-specific
identifiers. The split mirrors the `.dev.vars` / `.dev.vars.example` convention:

| File | Tracked? | Holds |
| --- | --- | --- |
| `wrangler.example.jsonc` | ✅ committed | the template — shared, non-secret config with `database_id` left as `REPLACE_WITH_D1_DATABASE_ID` |
| `wrangler.jsonc` | 🚫 gitignored | your real config — the same file with **your** D1 `database_id` filled in |

You make the gitignored copy once with `cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc`,
then paste in the `database_id` that `wrangler d1 create` prints. Wrangler auto-discovers
`wrangler.jsonc`, so `wrangler dev` / `wrangler deploy` / `pnpm deploy` just work — no flags.

Why not a secret? A D1 `database_id` configures a **binding**, which Wrangler resolves at
*deploy* time from the config file; secrets (`wrangler secret put`) are *runtime* env vars
the Worker reads at request time and can't wire up a binding. (The id isn't actually a
credential — it only identifies the database within your account, which is reachable only with
your Cloudflare API token — but keeping it out of the repo stops forks from pointing at it.)

> **Maintainers:** when you add shared config (a new `var`, binding, or route), update
> `wrangler.example.jsonc` too — existing clones won't pick it up automatically, since their
> real `wrangler.jsonc` is gitignored.

### Deploy steps

```bash
# 1. Create your local config, then the R2 bucket (blobs) and D1 database (metadata)
cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
wrangler r2 bucket create canopy-drive
wrangler d1 create canopy
#    → paste the printed database_id into d1_databases[0].database_id in wrangler.jsonc

# 2. Set secrets (run from apps/api)
wrangler secret put OIDC_CLIENT_SECRET   # only if your OIDC client is confidential
wrangler secret put SESSION_SECRET       # 32+ random bytes; encrypts the session cookie + stored secrets (AI keys, tokens) at rest

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

- **Documentation + demo come from GitHub.** Set `GITHUB_REPO` (e.g. `owner/repo`, optional
  `GITHUB_BRANCH`, and `GITHUB_TOKEN` for a private repo) and the read-only **documentation** mount and
  the **anonymous demo drive** are read live from the repo via `@canopy/connector-github` — no
  files bundled, no R2 bucket for them. Unset (dev), they fall back to the in-repo `documentation/` and
  `demo/` folders. Signed-in users' drives are the real connector (local FS / R2).
- **AI is optional but on by default.** `wrangler.example.jsonc` binds **Workers AI**
  (`ai.binding = "AI"`), so the **Document AI** plugin labels uploads out of the box with no key.
  Remove that binding to turn it off; either way, signed-in users can add their own Gemini or
  OpenAI-compatible provider under **Settings → AI**.
- **`wrangler dev`** (the local Cloudflare runtime) needs `workerd`, whose native build pnpm
  blocks by default — run `pnpm approve-builds` once if you want it. `wrangler deploy` does
  not need it. For day-to-day work, prefer `pnpm dev`.

## Node / Docker (single process)

```bash
pnpm start
```

This builds the portal, then runs `apps/api` which detects `apps/portal/dist` and serves the
SPA (with SPA fallback) **and** `/api` on one port (`:8787`). On Node the drive uses **libsql
(SQLite) + the filesystem**; point its data root (the `canopy.db` file and the `blobs/` tree
live there) at any folder:

```bash
CANOPY_LOCAL_ROOT=/srv/canopy pnpm start
```

> **AI (optional).** On Node, enable a base AI provider with `GOOGLE_AI_API_KEY` (Gemini) or
> `OPENAI_BASE_URL` (a local / OpenAI-compatible model) so the **Document AI** plugin can label
> uploads. With neither set, AI is simply off until a signed-in user adds their own provider
> under **Settings → AI**.

A `Dockerfile` at the repo root does this in a multi-stage build (install + `vite build`,
then run the API serving `dist` + `/api`):

```bash
docker build -t canopy .
docker run -p 8787:8787 \
  -v /srv/files:/data \
  -e SESSION_SECRET=... -e OIDC_ISSUER=... -e OIDC_CLIENT_ID=... -e OIDC_CLIENT_SECRET=... \
  canopy
```

> **Single instance only for live collaboration.** Real-time co-editing keeps each
> document's authoritative state in memory in one process, so the Node target must run as a
> **single replica** — scale it out behind a load balancer and editors of the same document
> can land on different replicas and diverge. See
> [Real-time editing](architecture) for why and what scaling it would take. Cloudflare
> (Durable Objects) is not affected.

The drive's data root — the SQLite DB plus the content-addressed blobs — is the `/data` volume
(`CANOPY_LOCAL_ROOT`). Auth env vars (see
`apps/api/.dev.vars.example`) are passed at runtime — secrets are never baked into the image
(`.dev.vars` is in `.dockerignore`). The image has a healthcheck on `/api/health`.

## A note on auth callbacks

The OIDC redirect URI is derived from `APP_BASE_URL` — so it differs per environment
(`http://localhost:5768/api/auth/callback` in dev, `https://your-domain/api/auth/callback` in
production). Each one must be registered as an allowed callback on your OIDC client, or login
fails with a `redirect_uri` mismatch.
