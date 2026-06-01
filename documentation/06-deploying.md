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

The Worker entry is `apps/api/src/worker-cf.ts` (it re-exports the portable handler from
`worker.ts` plus the document-parser Durable Object); configuration is the committed
`wrangler.jsonc` at the **repo root**. It's one Worker for the whole monorepo — the root is the build context,
so the `@canopy/*` workspace packages resolve (they export `./src` directly) and the Worker
bundles from source with no per-package build step.

The key bits:

- `assets.directory: "apps/portal/dist"` — the built SPA is uploaded as static assets.
- `not_found_handling: "single-page-application"` — unmatched paths fall back to `index.html`.
- `run_worker_first: ["/api/*", "/dav/*"]` — the Worker handles the API and WebDAV; everything
  else is served straight from the asset store, so the Worker isn't even invoked for static files.
- `d1_databases` — the `DB` binding holds the drive's metadata (files, versions, blob
  refcounts, permissions). The schema is applied by a migration runner on first request.
- `r2_buckets` — the `BUCKET` binding holds the content-addressed **blobs**. Workers have no
  filesystem, so on Cloudflare the drive is always D1 + R2 (the libsql/fs adapters are Node-only).

### Config: committed and ID-less (resource provisioning)

The committed `wrangler.jsonc` declares its R2/D1/AI bindings **without IDs**. On the first
`wrangler deploy` (or via the button), Cloudflare **provisions** the bucket and database, binds
them, and writes the new IDs back into your *local* copy of the file. The committed config stays
ID-less — that's what lets a fork or the "Deploy to Cloudflare" button stand up its own resources
with zero setup, and why there's no longer a gitignored template to copy.

> Keep the provisioned IDs out of commits (`git checkout wrangler.jsonc` after a deploy if you
> see them appear) so the next deployer still gets clean provisioning. To deploy repeatedly
> against the *same* database, either leave the IDs in your working copy (just don't commit
> them) or select the existing `canopy` database when Wrangler prompts.

### One click: Deploy to Cloudflare

The button in the repo `README` (`https://deploy.workers.cloudflare.com/?url=<repo>`) forks the
repo into your GitHub account and deploys it via Workers Builds, provisioning R2/D1/AI. When
prompted, set **Build command** to `pnpm install && pnpm --filter @canopy/portal build` and
**Deploy command** to `npx wrangler deploy`. A fresh deploy comes up as the anonymous demo;
add the OIDC vars + secrets afterwards to enable login.

### Deploy from your machine

```bash
# 1. (optional) Set secrets to enable login — skip for the anonymous demo:
wrangler secret put OIDC_CLIENT_SECRET   # only if your OIDC client is confidential
wrangler secret put SESSION_SECRET       # 32+ random bytes; encrypts the session cookie + stored secrets (AI keys, tokens) at rest

# 2. (optional) To enable login, add vars.OIDC_ISSUER / OIDC_CLIENT_ID (and optionally
#    APP_BASE_URL) to wrangler.jsonc, then register <your-url>/api/auth/callback as an
#    allowed callback on the OIDC client.

# 3. Build the SPA and deploy the Worker (from the repo root). Wrangler provisions R2/D1/AI
#    on the first run.
pnpm deploy
```

`pnpm deploy` runs `vite build` for the portal and then `wrangler deploy`. To validate the
bundle and bindings without shipping:

```bash
wrangler deploy --dry-run   # from the repo root
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

## Document-parser container (optional)

A Cloudflare **Container** the Worker calls on demand, for two jobs a Workers isolate can't do
itself:

- **Heavy / large document parsing** — big PDFs, spreadsheet tables, and document outlines,
  parsed off the isolate (no CPU/memory ceiling).
- **Reaching a tailnet-only NAS** — a Worker can't be a Tailscale peer, but the container runs a
  `tsnet` (userspace Tailscale) sidecar and joins your tailnet, so a [Synology](plugin-synology)
  space backed by a tailnet host works from the edge.

It's the `apps/docworker` service (Hono + the `@canopy/docworker` parser) packaged with the
sidecar into one `linux/amd64` image, managed by a `DocWorker` **Durable Object**. **It's
optional:** the Worker parses in-process by default and falls back to in-process if the container
isn't deployed or is unreachable; the Node target never uses it.

### Per-tenant tailnet (keys live in the DB, not the deploy)

Tailnet auth is **per user**, not a deployment secret. Each user's Tailscale key + host live in
their **encrypted connector settings** (the DB). On a request, the Worker spins up a **per-user
container instance** — keyed by the tailnet identity — and passes the key over the internal
Worker→DO hop; that instance joins *that* user's tailnet and reaches *their* NAS. So one tenant's
parser can never touch another's tailnet, and **no tailnet key ever lives in `wrangler.jsonc` or
a `wrangler secret`**. The container **scales to zero** — the first request after idle pays a
cold start (container boot + tailnet handshake, a few seconds), then stays warm for `sleepAfter`.

Auth on the Worker→container hop is the **DO binding itself** (a container has no public
ingress), so no shared secret is required. `DOCWORKER_TOKEN` is optional defense-in-depth; a
global `TS_AUTHKEY` secret is only a single-tenant fallback for a one-NAS homelab.

### Deploying it

`containers` + the `DocWorker` DO are declared in the committed `wrangler.jsonc`, so a normal
deploy **builds the image** (Docker must be running) and ships it:

```bash
pnpm deploy:cf              # build portal → wrangler deploy (builds + rolls out the container)
```

To deploy the Worker **without** the container — a fork with no NAS, or no Docker — skip the
container build:

```bash
pnpm deploy:cf:worker-only  # wrangler deploy --containers-rollout=none
```

The image build context is the **repo root** (so the `@canopy/*` workspace packages resolve).
For working on the service itself:

```bash
pnpm docworker:dev          # run the parser service in pure Node (no container, no tailnet)
pnpm docworker:build        # build the linux/amd64 image locally
```

See [Synology](plugin-synology) for the Tailscale connection setup that uses this.

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
`.dev.vars.example`) are passed at runtime — secrets are never baked into the image
(`.dev.vars` is in `.dockerignore`). The image has a healthcheck on `/api/health`.

## A note on auth callbacks

The OIDC redirect URI is derived from `APP_BASE_URL` — so it differs per environment
(`http://localhost:5768/api/auth/callback` in dev, `https://your-domain/api/auth/callback` in
production). Each one must be registered as an allowed callback on your OIDC client, or login
fails with a `redirect_uri` mismatch.
