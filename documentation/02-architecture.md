# Architecture

## Monorepo layout

Canopy is a pnpm workspace. Packages are small and single-purpose so plugins can be their
own publishable npm packages alongside the core.

```
packages/
  core/                 @canopy/core             interfaces only, zero runtime deps   [built]
  store/                @canopy/store            DB-backed drive: blobs+dedup, files, versions  [built]
  plugin-sources/       @canopy/plugin-sources   resolve github / npm / zip plugins   [built]
  runtimes/
    node/               @canopy/runtime-node     isolated-vm sandbox adapter          [planned]
    cf-loader/          @canopy/runtime-cf-loader  Cloudflare Worker Loader adapter   [planned]
  connectors/
    local/              @canopy/connector-local  local filesystem connector           [built]
    r2/                 @canopy/connector-r2     Cloudflare R2 connector               [built]
    github/             @canopy/connector-github read-only repo connector (documentation+demo)  [built]
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
runs) with `GET /api/plugins/active` (the effective set = installs ∪ space-applied), and the
data-source endpoints `GET /api/tasks`, `GET /api/calendar`, `GET /api/integrations`. See
[How plugins work](how-plugins-work) for the contract behind these.

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
- **Connected (`external`) — in progress.** You point Canopy at a filesystem / S3 / R2 you own;
  it **indexes** the objects (by key + etag) into the same `files`/`file_versions` tables as
  references. There the bucket is the source of truth and the DB is a cache, kept fresh by the
  connector's `changes()` feed where available, else a periodic crawl. The crawl is a long-running
  job — a **Cloudflare Workflow** on the edge, an in-process runner on Node.

Vector and full-text search layer on top of the index later.

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
