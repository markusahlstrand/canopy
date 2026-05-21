# Architecture

## Monorepo layout

Canopy is a pnpm workspace. Packages are small and single-purpose so plugins can be their
own publishable npm packages alongside the core.

```
packages/
  core/                 @canopy/core             interfaces only, zero runtime deps   [built]
  plugin-sources/       @canopy/plugin-sources   resolve github / npm / zip plugins   [built]
  runtimes/
    node/               @canopy/runtime-node     isolated-vm sandbox adapter          [planned]
    cf-loader/          @canopy/runtime-cf-loader  Cloudflare Worker Loader adapter   [planned]
  connectors/
    local/              @canopy/connector-local  local filesystem connector           [built]
    r2/                 @canopy/connector-r2     Cloudflare R2 connector               [built]
    github/             @canopy/connector-github read-only repo connector (docs+demo)  [built]
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

## How a request flows today

The portal is a static SPA; it can't touch a filesystem or a bucket directly. So reads go
through the API:

```
portal (browser)
  └─ GET /api/files?mount=local&path=Documents
       └─ @canopy/api (Hono)  ── picks the "local" connector
            └─ @canopy/connector-local  ── reads node:fs
                 └─ Page<StorageEntry>  ──►  JSON  ──►  mapped to the UI's FileItem
```

The API is **mount-keyed**: `createApp(connectors)` takes a map like
`{ local: driveConnector, docs: docsConnector }`, and every route reads `?mount=`. One
deployment can expose several connectors at once — that's how the Docs plugin gets a
read-only `docs` mount next to your drive.

Routes that exist today: `GET /api/files`, `GET /api/file`, `PUT /api/file`,
`DELETE /api/file`, `POST /api/upload`, `GET /api/health`.

## Deployment

- **Today (Node):** `apps/api/src/node.ts` serves the Hono app via `@hono/node-server`; the
  portal runs on Vite and proxies `/api` to it. This is the local/dev/Docker path.
- **Planned (Cloudflare):** the same `app.ts` runs unchanged on a Worker; a Worker entry
  serves the built SPA assets and the API routes together, with R2 as the connector. Hono's
  portability is the whole reason `app.ts` is split from `node.ts`.

## The index vs. storage model _(planned)_

The hard problem Canopy is built around: the bucket is the source of truth, but listing and
searching it live doesn't scale. The plan is a SQL **index** that mirrors entries, kept
fresh by:

- the connector's optional `changes()` feed where the backend supports eventing, and
- a periodic crawl + lazy reconcile-on-read where it doesn't (e.g. plain R2).

Vector and full-text search layer on top of that index later. None of this is built yet —
today the local connector lists straight from the filesystem on every request.
