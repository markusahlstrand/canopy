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

## Text extraction and backfill

PDF and UTF-8 text uploads extract at most 200,000 characters for content search. The scope stores the
extractor result as `indexed`, `empty`, `unsupported`, or `failed`, alongside the file
version and extractor revision. Search ignores text from a superseded version.

The `text-backfill` job scans current blob versions in batches of 20. It picks up
missing or stale text, retries failed rows on a later run, and revisits unsupported
rows when the extractor revision changes. The scope sweeper advances durable job
passes and starts a new pass every 12 hours. Uploads queue a run immediately; the
job driver coalesces concurrent starts. A space administrator can start one manually
with `POST /api/maintenance/text-backfill` (response: `runId`, `status`).

## Viewers

The first-party image viewer is a trusted component compiled into the drive. The
drive also loads installed viewers and full-view apps from personal and space plugin
installs at runtime. Those plugins run in opaque-origin iframes, receive only the
capabilities approved for the install, and register their file matches or app view
from `canopy.json`. The Plugins dialog offers bundled catalog entries, local source,
and GitHub, npm, or ZIP imports. See [How plugins work](../../documentation/03-how-plugins-work.md)
and [Writing a plugin](../../documentation/05-writing-a-plugin.md) for the current
contract. The old portal's build-time registration is retired.

## Event feed

`GET /api/changes` pages file and folder metadata invalidations from the scope's
Substrat outbox, using event ids as exclusive cursors. Each returned entity is
checked with `drive:read`; a trashed file is returned as a tombstone (`file: null`).
The response contains current metadata so replaying an old event cannot resurrect
an obsolete name or version. It contains no bytes. The browser applies pages into
IndexedDB, committing rows and cursor together under the current scope principal.
After an online listing, it catches up in the background. If the network fails while
the signed-in drive is open, folder browsing falls back to those saved names; writes,
search, trash and content previews remain unavailable until Refresh reconnects.
The browser remembers the last authenticated principal for the current origin and
selected site. Once the first feed pass has completed, a cold load can show that
principal's saved names when `/api/me` is unreachable. An online 401 or sign-out
clears the mirror, including the offline identity; sign-out in another tab also hides
an already-open offline view.

## Historical versions

`GET /api/files/{fileId}/versions/{versionId}` resolves a historical version only
when it belongs to that live file and the principal holds `drive:read` on the file.
`GET /api/files/{fileId}/versions/{versionId}/content` opens that version's attachment
through the same authenticated, scope-local read and attachment gates as current bytes.
Historical reads do not change the current version. Trashed files and mismatched
version ids are refused; connected-source bytes still return 501.

Writers can restore an older stored version as a new current history entry, and
mark versions to keep. The designation persists; pruning is not yet wired in the
vertical. The Versions tab loads older pages through the API’s continuation links
and retains the loaded rows when a page fails so the user can retry.

## Descriptions and labels

The preview’s Details tab reads and edits descriptive metadata with file-level
permissions. Revisions protect against stale edits. Labels carry no access rights.
Search matches names, current extracted text, descriptions and labels; the kernel’s
FTS triggers update metadata search in the same write. Metadata hits are distinguished
in the palette and are filtered through the live file’s read permission.

## Live updates

`GET /api/live` is Substrat's WebSocket subscription for authenticated pages. The
worker resolves the selected space and principal through its normal session path;
the scope sends only file and folder invalidations that pass `drive:read` on the
changed entity. The browser re-reads the current view and syncs the event mirror
when a frame arrives. It also polls once a minute and on returning to a visible
tab, covering disconnected sockets, unsupported network paths, and changes that
cannot be pushed after a permission is revoked.

## Moving files and folders

Move opens a same-space destination picker for one item or a selection. Files and
folders can also be dragged onto folders. Self/descendant destinations are refused;
the server checks source and destination authority, and access follows the destination.
Name conflicts remain errors. Each move is atomic, while selections run sequentially;
after a partial failure, retry moves only the remaining items.

## Paged browsing

The drive and Move picker follow API continuation links for folders. File and Trash
listings also load more on demand, preserving rows on a failed page for retry.
An empty filtered Trash page does not end the walk while a continuation exists.
Refresh/live invalidation starts a fresh listing; offline browsing uses saved names.

## Shared folders

Shared with me lists folders granted directly to the current principal in the selected
space. The kernel checks visibility; the projection only supplies discovery. Duplicate
grants produce one row, and renamed folders retain their identity. This view does not
aggregate other spaces or change the membership model: a member reads the whole space.
It is unavailable while browsing the offline mirror.

## Not yet wired

WebDAV, connector-backed reads, and any migration of existing canopy spaces. See
[`documentation/planning/scope-model-mapping.md`](../../documentation/planning/scope-model-mapping.md) §3.

Text edits use `PUT /api/files/:fileId/content?expectedVersion=:versionId`. The worker requires write access, stored text content, valid UTF-8, and at most 200,000 characters (800,000 bytes). The scope atomically refuses a stale expected version with 409, including writes that race during attachment upload. As with ordinary uploads, an attachment can remain unreferenced if recording its version fails. The editor must preserve the draft on conflict and reload before retrying.

The preview offers **Edit text** to writers of stored UTF-8 text, Markdown, JSON and XML when the complete body fits the preview limit. Saves create ordinary immutable versions and preserve drafts on failure. A conflicting edit must be copied or discarded before reloading the latest version; there is no live collaborative text editing in this editor.
