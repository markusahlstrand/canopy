# Cloudflare + Hono stack conventions

The Canopy house stack for the API worker. Read this with the actual code in `apps/api/src/` open —
this doc is the map; the code is the territory.

## The stack

| Concern | Choice | Where |
|---|---|---|
| HTTP framework | **Hono 4** | `apps/api/src/app.ts` builds the app; route groups mounted there |
| Validation | **Zod 4** | request bodies/queries; schemas mirror the spec's DTO `model`s |
| Auth | **jose 6 + OIDC** (authhero-style) | `apps/api/src/auth/`; bearer verification, not bespoke |
| Runtime | **Cloudflare Workers** primary, **Node** parallel | `worker-cf.ts` (CF) + `node.ts` (Node) entrypoints |
| Contract | **TypeSpec** → OpenAPI 3 | `apps/api/spec/`; `@typespec/openapi3` emits the doc |
| Persistence / IO | **adapters** | `@canopy/store`, `@canopy/connector-*`, `@canopy/core` (workspace deps) |
| MCP / containers | as wired | `src/mcp/`, `src/container/` — follow existing patterns |

Slim core, capability via plugins/connectors. Cloudflare-first, but never CF-only in shared code.

## Spec → code mapping (the patterns)

### Entity → schema + store
A `@key` entity becomes:
1. a **Zod schema** (`EpisodeSchema`) — the validated shape, source of the TS type via `z.infer`.
2. persistence through **`@canopy/store`** — don't open a DB client inline. The store/adapter
   interface is the seam; a Workers deployment binds D1/R2, a Node deployment binds its own driver,
   and the route code doesn't know the difference.

Don't define a hand-written `interface Episode {…}` next to the Zod schema — infer it.

### Endpoint → Hono route
Each spec op (`interface` method with `@operationId`) becomes one Hono handler:
- mount under the spec's `@route`, with the matching HTTP verb;
- validate `@body`/`@query` with the Zod DTO schema (`zValidator` or explicit `.parse`);
- return the spec's response DTO; map errors to the spec's `Thing | Error` union and status codes
  (201 for create with `@statusCode`, etc.);
- name the handler/route so it's traceable to the `operationId` — that id is the contract join and
  shows up in the emitted OpenAPI.

Group routes by resource into a Hono sub-app and mount it in `app.ts`, the way existing groups are.

### Auth → middleware
Default every route to bearer auth via the existing `auth/` helpers (jose verification of the OIDC
token). Only the ops the spec marks `@useAuth(NoAuth)` skip it. Scope mutations to the
owner/member — read the principal from the verified token, don't trust a body field.

### Flow (Arazzo) → orchestration
A flow constrains *ordering and guards* across endpoints (e.g. can't `publishEpisode` before
`createEpisode`; emit `EpisodePublished` after). Implement those as guards/sequencing in the handlers
or a small orchestration helper — the flow doesn't add new endpoints, it sequences existing ones.

## Dual-runtime rules

- Shared code (routes, services, schemas) must run on **both** Workers and Node. No `node:fs`, no
  CF-only globals in shared modules.
- Runtime-specific wiring lives at the entrypoints: `worker-cf.ts` (bindings, DO/R2/D1) and `node.ts`
  (`@hono/node-server`). New runtime-specific needs go behind an adapter, surfaced at the entrypoint —
  not branched inline in a handler.

## Adapter discipline

Anything that talks to the outside — storage, a NAS/repo connector, an external API — goes through an
interface in `@canopy/store` / `@canopy/connector-*`, not a direct SDK import in the worker. This is
the core reason the same app runs on Workers and Node and against R2/local/Synology/GitHub. If a new
integration is needed, add or extend a connector; don't inline it.

## Verify

- `apps/api` spec compiles + OpenAPI emits (TypeSpec compiler + `@typespec/openapi3` are devDeps).
- `tsc` clean on new code.
- routes ↔ spec `operationId`s and DTO shapes line up (diff against the emitted OpenAPI if unsure).
- no direct external SDK import that should be an adapter.
- versions match `apps/api/package.json` — don't pin older Hono/Zod/jose.
