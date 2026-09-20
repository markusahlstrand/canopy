# @canopy/drive-vertical

Canopy's drive, packaged as a deployable Substrat vertical: **one Durable Object per
space**, the kernel's permission model, and no control plane of its own.

```
src/worker.ts      the deployable worker — ScopeDO, IdentityDO, SweeperDO, the auth seam
src/provision.ts   what `substrat push` reads: modules, roles, grant shapes
wrangler.jsonc     local `wrangler dev` only — the hosted deploy authors no wrangler config
```

The drive itself is [`@canopy/scope-drive`](../../packages/scope-drive). This app is the
deployment shell around it.

## Deploying to the platform

```sh
pnpm --filter @canopy/scope-drive build     # the vertical is bundled, so the package ships dist
pnpm --filter @canopy/drive-vertical check  # boundary-lint + the permission surface + its digest
substrat login                              # browser round-trip; the CLI session expires
pnpm --filter @canopy/drive-vertical push
```

`check` needs no credentials and is the one to run in CI. `push` uploads the worker,
registers the permission surface under the workspace tenant, and hands the platform the
`runtimeNeeds` from `package.json` — the bindings, the node-compat flag and the entry.
**No wrangler config is involved in that path**: anything in `wrangler.jsonc` is invisible
to a pushed install, by design.

## What an install gets, and what it does not

A fresh install **authenticates nobody**. There is no dev header and no fallback caller —
a header naming the caller is an impersonation bypass one environment variable from being
live, so the worker resolves a principal exactly one way: the configured OIDC issuer
verifies the request, and the tenant's `IdentityDO` maps that subject to a principal in
this scope. Until an install is given an issuer, every `/api/*` call is 401 and that is
the correct state.

The issuer arrives as one delivered value (`substrat:auth`, written by the dashboard's
Identity tab and read through `instanceAuthFor`), so one serving script runs many issuers
and a tenant's choice is a tenant's. `AUTH_PROVIDER=oidc` + `OIDC_ISSUER` is the
standalone fallback. Point it at authhero, or anything else that speaks OIDC — that is
configuration, not code.

The browser session is established at `/api/auth/login|callback|logout`, which the
provider itself serves; this vertical runs no credential store and hosts no sign-up.

At provision the platform names an owner: the worker records it in `IdentityDO` (so the
first sign-in claims the seat), adds the scope to this deployment's sweep roster, and
assigns the `owner` role — which holds all three drive keys scope-wide, because the owner
of a space may write anywhere in their own space. A `member` reads; write below the root
is a grant on a folder. If the owner never signs in, the platform can mint a claim link
once the first-sign-in window closes.

## Local

```sh
pnpm --filter @canopy/drive-vertical dev    # wrangler dev with ALLOW_DEV_NODE=true
```

`ALLOW_DEV_NODE` addresses an instance when no router asserted one. It is an **address,
not an identity** — it says which space an un-routed request belongs to and grants nobody
anything.

## Bytes

A write is three hops, and the shape is forced rather than chosen: an attachment binds to
an entity, so the file row must exist before bytes can attach to it, and bytes must not
ride `invoke` — a structured-clone pipe under per-scope serialization is the wrong path
for megabytes.

```
POST /api/folders/{folderId}/content?name=report.pdf   (raw body, ≤ 25 MB)
  → drive/ensure-file          the row bytes will hang off
  → attachments.upload         bytes to the per-tenant store, sha256 at rest
  → drive/record-version       the version names the attachment

GET  /api/files/{fileId}/content
  → drive/get-file             which version is current
  → attachments.open           gated by the declared target's read key
```

The store is platform-minted, one bucket per tenant, bound as `BLOBS__<tenantId>` and
declared in `substrat.runtimeNeeds.blobStores`. The vertical never names a bucket and
never builds a key: per-scope isolation inside the store is the kernel's derived prefix.

Access is the kernel's too — `attachmentTargets` in the manifest binds file bytes to
`drive:read` / `drive:write`, per entity, so a grant narrowed to one folder reaches the
bytes under it and nothing else. The drive holds no second rule about who may download
what.

An upload is **bounded at 25 MB**, checked against `content-length` and again while
reading, because the header can be absent or wrong. The attachment surface takes bytes
rather than a stream — it hashes them and records the length — so an upload is
materialized in an isolate that has 128 MB for everything it is doing, while Cloudflare
will happily hand a worker a 100 MB body. Raising the ceiling is a decision about isolate
memory, not a config tweak.

`record-version` **verifies rather than trusts**: it carries a URL, so it reads the
attachment row itself, refuses an id belonging to another file, and takes `size` and
`mime` from the row. A version cannot describe bytes as something they are not, and a
file's history cannot record a write that never happened.

A version whose source is a connected system refuses with a 501 that says so, rather than
serving an empty body that reads as an empty file.

## Not yet wired

Content extraction and search, the changes feed, WebDAV, connector-backed reads, and any
migration of existing canopy spaces. See
[`documentation/planning/scope-model-mapping.md`](../../documentation/planning/scope-model-mapping.md) §3.
