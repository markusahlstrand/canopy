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

Content search reads the kernel's attachment text (#169). Each upload queues extraction
inside the same transaction as the upload. The supported types are text, Markdown, CSV,
HTML, DOCX, XLSX, PPTX and PDF; a generic type is read by its file extension.

After an upload, a text save or a WebDAV write, the worker runs the scope's due jobs once
the response has been sent, so new content is searchable within seconds. The sweeper runs
them every two minutes as a backstop, together with the kernel's one-off backfill for
attachments that predate extraction. The kernel bounds each extraction in size, time and
memory and records why a file has no text: `empty` (for example a scan), `unsupported`,
or `failed`.

`drive/search` ranks content matches by bm25 beside name and metadata matches. It reads the
kernel's index directly, because the public `ScopeAttachments.search` returns no score and
no snippet. A match counts only for the file's current version, and every hit is
permission-checked. The kernel indexes whole words with prefix matching, so `inv` finds
"invoice", but a fragment from the middle of a word does not match. `GET
/api/files/:id/text` reports the current version's status, and a space administrator can
run due extraction now with `POST /api/maintenance/text-backfill`.

## Viewers

The first-party image viewer is a trusted component compiled into the drive. The
drive also loads installed viewers and full-view apps from personal and space plugin
installs at runtime. Those plugins run in opaque-origin iframes, receive only the
capabilities approved for the install, and register their file matches or app view
from `canopy.json`. The Plugins dialog offers bundled catalog entries, local source,
and GitHub, npm, or ZIP imports. See [How plugins work](../../documentation/03-how-plugins-work.md)
and [Writing a plugin](../../documentation/05-writing-a-plugin.md) for the current
contract. The [viewer decision](../../documentation/planning/web-component-viewers.md)
records the earlier bundled-viewer design. The old portal's build-time registration is retired.

## Event feed

`GET /api/changes` pages file and folder metadata invalidations from the scope's
Substrat outbox, using event ids as exclusive cursors. Each returned entity is
checked with `drive:read`; a trashed file is returned as a tombstone (`file: null`).
The response contains current metadata so replaying an old event cannot resurrect
an obsolete name or version. It contains no bytes. The browser applies pages into
IndexedDB, committing rows and cursor together under the current scope principal.
After an online listing, it catches up in the background. If the network fails while
the signed-in drive is open, folder browsing falls back to those saved names. A person
can mark a folder available offline on this device; the browser recursively downloads
its current, readable file versions into a separate content store (20 MB per file,
250 MB per space) and reports whether the download is complete. Those saved versions
can be opened and downloaded read-only during an outage. Writes, search, and Trash
remain unavailable until Refresh reconnects.
The browser remembers the last authenticated principal for the current origin and
selected site. Once the first feed pass has completed, a cold load can show that
principal's saved names when `/api/me` is unreachable. An online 401 or sign-out
clears the mirror, including the offline identity; sign-out in another tab also hides
an already-open offline view.
The content store is keyed by principal, space, file and version. Sign-out, an online
401, and cross-tab logout clear both the metadata mirror and saved file bytes. A
successful online folder walk removes deleted or superseded versions; a 403/404
removes the affected folder pin and its bytes. A failed walk remains visibly incomplete.

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

**Document AI** fills these in for new uploads when a space administrator turns on
*Label new uploads automatically* in space settings. Each browser, WebDAV or editor write
starts a kernel job run for that file (`@canopy/scope-drive` / `auto-label`, instance =
file id). The run waits until the kernel has indexed the file's text, retrying with
backoff, so it does not matter whether the upload's own `runDueJobs`, a sweep or a
retry does the extraction. It then sends the first 12,000 characters and the file name
to a model through `createModelHost` and the platform's Workers AI binding, and writes
a document-type label and, if empty, a description. The write names the version the
model read and is refused if the file has changed since. The model's answer is a
memoised step, so a pass the runtime cuts short is resumed by the sweeper without
paying twice. One run per file: a live run is joined, and a run follows a version that replaces
the one it read for one more round. Once the model has answered about a file it is
left alone for that version and for a day, so autosaving costs at most one call a day,
and a different document saved over it is picked up after that. A file with no text
layer is not retried until a new version arrives. A run that stopped for another reason
(extraction missing or failed, access lost), or failed, closes nothing. An empty "New →"
starter queues nothing; its first real save does. People's own labels and descriptions are never replaced. Files with no text
layer are skipped. Links and mail addresses are stripped from what the model writes.
`DOCUMENT_AI_MODEL` overrides the default model. Each run's outcome is in its counters
and logged as `drive.document-ai.done`; usage lines as `drive.document-ai.usage`.

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

## WebDAV

`/dav/` serves the drive over WebDAV (RFC 4918, class 1 and 2) for Finder, File Explorer
and other clients. The account menu's **Connect with WebDAV…** shows the server address
and manages app passwords.

**Sign-in.** A client sends HTTP Basic with an app password; the user name is ignored.
A signed-in person creates up to 20 passwords, each named after a device or app, and
sees each secret once (`GET`/`POST /api/app-passwords`, `DELETE /api/app-passwords/:id`).
Only a SHA-256 hash is stored, in the tenant's identity DO, keyed by the login's OIDC
subject rather than a principal. Every request resolves that subject to a principal in
each space through the same `identity` rows as a browser session, so removing a member
from a space stops their password reaching it, and revoking a password stops it at once.

**Namespace.** It is rebuilt on every request:

- `/dav/` lists one collection per space the login can enter. Two spaces with the same
  name get their slug appended.
- `/dav/Shared with me/` lists folders granted directly to the login, in every space.
  If a space is called "Shared with me", the space keeps the name and this collection
  becomes "Shared with me (Canopy 1)".
- Each mount is named `<folder> — <space> [<key>]`. The key comes from the space and
  folder id, so a mount's URL survives a folder rename, and a withdrawn grant makes the
  URL answer 404.

**Access.** Every read and write is a scope operation or attachment call made as the
caller, so viewers can read but not write, and a folder grant allows writing only in
that folder's subtree.

**Methods and writes.**

| Method | What it does |
|---|---|
| `PUT` | Records a new version, up to 25 MB. |
| `DELETE` | Moves a file to Trash. A trashed file's name stays taken, so reusing it answers 409. |
| `MOVE` / `COPY` onto an existing file | Writes a new version of that file. |
| `MKCOL` | Creates a folder. |
| `PROPFIND` | Lists sizes and dates. |
| `LOCK` / `UNLOCK` | Return a token without enforcing a lock, because Finder mounts read-write only when it sees lock support. |

These answer 403 with a reason: deleting or copying a folder, and moving between spaces.
macOS `._*` and `.DS_Store` files are accepted and discarded. Hosted installs route
`/dav` and `/dav/*` to the worker through `runtimeNeeds.assets.runWorkerFirst`.

## Not yet wired

Connector-backed reads and any migration of existing canopy spaces. See
[`documentation/planning/scope-model-mapping.md`](../../documentation/planning/scope-model-mapping.md) §3.

Text edits use `PUT /api/files/:fileId/content?expectedVersion=:versionId`. The worker requires write access, stored text content, valid UTF-8, and at most 200,000 characters (800,000 bytes). The scope atomically refuses a stale expected version with 409, including writes that race during attachment upload. As with ordinary uploads, an attachment can remain unreferenced if recording its version fails. The editor must preserve the draft on conflict and reload before retrying.

The preview offers **Edit text** to writers of stored UTF-8 text, Markdown, JSON and XML when the complete body fits the preview limit. Saves create ordinary immutable versions and preserve drafts on failure. A conflicting edit must be copied or discarded before reloading the latest version; there is no live collaborative text editing in this editor.
