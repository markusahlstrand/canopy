# Architecture

## Monorepo layout

Canopy is a pnpm workspace. Packages are small and single-purpose so plugins can be their
own publishable npm packages alongside the core.

```
packages/
  core/                 @canopy/core             interfaces only, zero runtime deps   [built]
  store/                @canopy/store            DB-backed drive: blobs+dedup, files, versions  [built]
  mirror/               @canopy/mirror           offline metadata-mirror read logic (shared client+server)  [built]
  plugin-sources/       @canopy/plugin-sources   resolve github / npm / zip plugins   [built]
  runtimes/
    node/               @canopy/runtime-node     isolated-vm sandbox adapter          [planned]
    cf-loader/          @canopy/runtime-cf-loader  Cloudflare Worker Loader adapter   [planned]
  connectors/
    local/              @canopy/connector-local  local filesystem connector           [built]
    r2/                 @canopy/connector-r2     Cloudflare R2 connector               [built]
    github/             @canopy/connector-github read-only repo connector (documentation+demo)  [built]
    synology/           @canopy/connector-synology Synology FileStation connector (NAS)  [built]
apps/
  api/                  @canopy/api              portable Hono server                 [built]
  portal/               @canopy/portal           Vite + React SPA                     [built]
```

The split that matters: **`core` contains only interfaces and the registry** — no Node
APIs, no React, no fetch. Everything concrete (a connector, a sandbox, a UI) depends on
`core`, never the other way around. That's what lets the same contracts run on Node today
and on a Cloudflare Worker later.

## The core interfaces

`@canopy/core` defines the contracts. The two that anchor everything:

```ts
// A storage backend. Trusted, typed I/O — the bucket is the source of truth.
interface StorageConnector {
  readonly id: string;
  list(path: string, opts?: ListOptions): Promise<Page<StorageEntry>>;
  stat(path: string): Promise<StorageEntry | null>;
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  write(path: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<StorageEntry>;
  remove(path: string): Promise<void>;
  signedUrl?(path: string, op: "get" | "put", expiresInSeconds?: number): Promise<string>;
  changes?(cursor?: string): AsyncIterable<ChangeEvent>;   // optional change feed for indexing
}

// A switchable sandbox for running untrusted plugin code (see "How plugins work").
interface PluginRuntime {
  readonly id: string; // "node" | "cf-loader" | "cf-wfp"
  load(bundle: PluginBundle, grants: CapabilityGrants): Promise<PluginInstance>;
  invoke<TIn, TOut>(instance: PluginInstance, hook: string, input: TIn): Promise<TOut>;
}
```

A `StorageEntry` is deliberately neutral — `kind` is just `"file" | "folder"`, plus
`size` and `modifiedAt`. It carries no notion of "PDF" or "image"; that's a UI concern the
portal derives from the file extension.

## How a request flows

The portal is a static SPA; it can't touch a database or a bucket directly, so everything
goes through the API. The **drive** is database-backed (`@canopy/store`), so a listing is a
query, not a bucket crawl:

```
portal (browser)
  └─ GET /api/files?path=Documents
       └─ @canopy/api (Hono)  ── tenant = signed-in user's sub
            └─ @canopy/store  ── SELECT files WHERE json_extract(metadata,'$.path') = ?
                 └─ { files, folders }  ──►  JSON  ──►  mapped to the UI's FileItem
```

Uploads are content-addressed: the browser hashes the bytes, calls `POST /api/uploads/prepare`,
and only `PUT`s the bytes on a miss (dedup); then `POST /api/files` creates the record. Downloads
stream from `GET /api/files/:id/content`.

Alongside the drive, the API still exposes **read-only mounts** over a plain `StorageConnector`
keyed by `?mount=` — that's how the Documentation plugin reads the `documentation` mount (and the anonymous `demo`
drive) live from GitHub.

Routes: `POST /api/uploads/prepare`, `PUT /api/uploads/:token`, `POST/GET /api/files`,
`GET /api/files/:id`, `GET /api/files/:id/content`, `PATCH /api/files/:id/metadata`,
`POST /api/files/:id/versions`, `DELETE /api/files/:id`, `GET /api/files?mount=…` (read-only),
`GET /api/file?mount=…` (read-only), `GET /api/health`, and `/api/auth/*`.

The same server also hosts the **plugin API**: `GET/PUT /api/plugins/installed` (a user's install
set), `GET/PUT /api/plugins/:id/settings` (per-user config; secrets encrypted), the per-place layer
`GET/POST/DELETE /api/spaces/:id/plugins` + `GET /api/plugins/:id/places` (owner-gated; what a space
runs) with `GET /api/plugins/active` (the effective set = installs ∪ space-applied), the
data-source endpoints `GET /api/tasks`, `GET /api/calendar`, `GET /api/integrations`, and
`GET /api/ai/models` (the caller's available AI models, fed to AI-powered plugins like Document
AI through the host **AI gateway** — a swappable provider abstraction over Workers AI, Gemini, or
a local model). See [How plugins work](how-plugins-work) for the contract behind these.

## Offline & sync

The portal is a PWA, and it stays useful — **read-only** — when the API can't be reached. It does
this not with a passive "cache what you saw" layer but with a **synced metadata mirror**: a scoped
local replica of the file metadata you can see, kept current by a diff from the server. D1 remains
the source of truth and authorization stays server-side; the browser just holds a copy of the
subset you're allowed to read.

**Reachability, not just `navigator.onLine`.** Every API call goes through one `apiFetch` wrapper
that marks the backend *reachable* on any HTTP response and *unreachable* when the request throws
(DNS failure, connection refused, a stopped dev server). `navigator.onLine` only knows the network
interface is up — commonly true while the API is down — so the UI trusts the wrapper instead:
"online" means **`navigator.onLine` && backend reachable**. A failed call raises an offline banner
and gates writes; the next successful call clears it. Recovery rides on the next real request (a
navigation, a window refocus, or the live channel reconnecting) — no background ping.

This also closes a subtle auth trap. `/api/auth/me` returning `authConfigured:false` means *auth is
switched off* (demo mode) — a very different thing from *the server is unreachable*. The client
keeps them apart: a network failure never collapses into demo mode; it falls back to the last-known
signed-in identity (flagged offline), so reloading while offline doesn't appear to sign you out.

**The metadata mirror (IndexedDB ← a cursor-based delta).** Every mutation bumps a per-space
monotonic `seq` (see [Storage & files](storage-and-files)), so the client can ask "give me
everything in my spaces since cursor N." `GET /api/changes` answers that delta — scoped to exactly
the spaces you can read (never widened by the client) — and the browser folds it into an IndexedDB
mirror of file rows (one per space, personal **and** group **and** connected/NAS). Folder reads are
then **mirror-first**: served locally and instantly (so navigating folders never waits on the
network, online or off), with a background delta refresh. The read logic lives in a dependency-free
`@canopy/mirror` package — `folderView`/`applyDelta` run the *same* code over D1 rows on the server
and over the mirror in the browser. Freshness is kept up out of band: a pull on reconnect/focus, a
slow safety-net interval, and a live **`SpaceChannel`** Durable Object that pushes an SSE "this
space advanced, go pull" nudge (it carries no file data, so the ACL surface stays in the delta
endpoint). The whole client path is behind a build flag, on by default (`VITE_SYNC_MIRROR=0` to
disable); the server side is additive and harmless when it's off.

**Content bytes (cache-first, stale-while-revalidate).** Metadata is small and syncs eagerly; file
*bytes* are large, so they're cached separately and lazily — the bytes of files you **open** and of
**starred** files (warmed as listings load). A previously-opened file then opens **instantly**,
online or offline: the cached copy is served first, and when online the client revalidates in the
background with a conditional request (`If-None-Match` → a cheap **`304`**, since Canopy is the
single point of entry and content rarely changes underneath you). Only a real change re-downloads
and refreshes the open viewer. Bytes live under a **per-space cache budget** — a per-device
preference (Off / 250 MB / 1 GB / 5 GB / Unlimited, default 1 GB) set from a space's "Offline
files…" menu — and the oldest in a space are evicted when it's exceeded.

The mirror and cache are **best-effort** — a blocked, full, or absent IndexedDB just means "no
offline copy", never an error. Writes (upload, create, rename, share) still require connectivity:
the app is **read + live, with no offline write queue** (deliberately deferred). The last-known
identity is also cached, so the account UI shows the real you offline.

**App shell + service worker.** A Workbox service worker (via `vite-plugin-pwa`) precaches the built
SPA and serves it for navigations. The SW ships only in the **production build** — dev runs plain
Vite with no SW, so in development the IndexedDB mirror + content cache are what provide offline.
The read-only mounts and the public share landing are excluded from the SPA navigation fallback.

## Deployment

- **Node / Docker:** `apps/api/src/node.ts` serves the Hono app via `@hono/node-server` (the portal
  proxies `/api` to it in dev, or it serves the built SPA in single-process mode). Storage is
  **libsql (SQLite) + the filesystem**.
- **Cloudflare:** the same `app.ts` runs on a single Worker — Static Assets serve the SPA, the
  Worker handles `/api/*`, storage is **D1 (metadata) + R2 (blobs)**. Hono's portability is the
  whole reason `app.ts` is split from `node.ts`. See [Deploying](deploying).

## Two content origins (the index vs. source-of-truth model)

Canopy is built around the tension between an index and the bytes' source of truth, and it
resolves it with **two kinds of version**:

- **Managed (`blob`).** Canopy owns the bytes: content-addressed in R2/fs by SHA-256, stored
  once, reference-counted, with the database as the source of truth. This is the default drive.
- **Connected (`external`).** You point Canopy at a filesystem / S3 / R2 / NAS you own; it
  **indexes** the objects (by key + etag) into the same `files`/`file_versions` tables as
  references, in a per-user read-only `connected` space. There the bucket is the source of truth
  and the DB is a cache, kept fresh by the connector's `changes()` feed where available, else a
  bounded crawl. A version reads through its connector either way. Because those rows live in D1,
  a connected space is **mirrored to the client like any other** — once indexed, browsing your NAS
  is offline/instant too (the bytes still stream through the connector, so opening a file needs the
  connector, or a cached copy).

  Indexing runs behind an **`IndexJobs` adapter** so the same trigger code works on both runtimes:
  a full crawl can far exceed a single Worker's subrequest/CPU budget, so on Cloudflare it's a
  durable **Workflow** (`ConnectorIndexWorkflow`) that reconciles **one folder per step** — each
  step gets a fresh budget and the engine resumes after a crash — while on Node it's an in-process
  loop over the same `reconcileConnectorFolder` primitive. It fires **on connect** (saving a
  connector's settings kicks a background index) and from a **"Sync / Re-index"** action in a
  connected space's context menu; the **scheduled sweep** (Cron on the edge, an interval on Node)
  and a lazy reconcile-on-view remain the safety net. Reconcile bumps the change `seq` in bulk, so
  the client's mirror picks up newly-indexed files through the same delta.

Full-text search is a core `SearchIndex` interface with swappable adapters — a SQLite/D1 **FTS5**
adapter is built (Vectorize / semantic search is a later one), fed in-process and queried by
plugins, not a monolithic plugin. The index is fed on every managed-drive change **and from the
connected-space reconcile** (a connector file's text is pulled through the connector, cached, and
indexed so it's searchable and reachable by assistants over MCP). Queries go through the host's
ACL-scoped `GET /api/search`, surfaced in a **⌘K command palette**; still being wired is the scoped
`queryIndex` grant that lets sandboxed plugins query. See
[What belongs in the core → search](what-belongs-in-the-core).

## Real-time editing (planned)

Documents edited in the portal (Markdown first) are collaborative: edits sync live between
everyone with the doc open. The model is a CRDT (**Yjs**) with **one room per document** —
every editor of a doc converges on a single authoritative instance that relays updates,
holds the merged state, and persists it through the same `StorageConnector` the drive uses.
Cursors and presence are ephemeral and never persisted. Saved versions are periodic Markdown
snapshots into `file_versions`; autosave overwrites one mutable HEAD, so typing doesn't churn
the version history.

The room is the only runtime-specific piece, and either way it speaks the standard Yjs sync
protocol over WebSocket, so the client is identical:

- **Cloudflare** — the room is a **Durable Object**, addressed by document id. The DO is the
  global single instance for that doc and uses the WebSocket Hibernation API, so idle docs
  cost nothing.
- **Node** — the room is an in-process `Map<docId, room>` over a `ws` server.

> **Limitation — collaboration assumes a single Node instance.** On Node the
> one-room-per-document guarantee holds only *within a single process*: the authoritative
> room lives in memory, keyed by document id, with no shared backplane. Run two or more Node
> replicas behind a load balancer and two editors of the same document can land on different
> replicas — each gets its own room, they won't see each other's edits, and the two HEADs
> diverge on save. Scaling the Node target horizontally would require routing every
> connection for a document to the same replica (sticky / consistent-hash by document id) or
> a pub/sub layer between replicas; **neither is implemented**, so the Node deployment is
> single-instance for live editing. Cloudflare has no such limit — a Durable Object is
> globally single-instance per id by construction, so deploy there if the realtime layer
> needs to scale.
