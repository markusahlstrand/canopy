# Connected spaces on Substrat file sources

*Written 2026-10-26; updated 2026-10-27. The provider package and hosted landing path are built. It covers how the drive
vertical gets connected spaces back, with a3doc (Wolters Kluwer) as the first source. It is also
Substrat's second file-bearing provider, after Microsoft 365 channel files.*

## 1. Why this is needed

The portal had connected spaces: a Synology NAS or a GitHub repo, browsable as a space. They were
lost when the portal was retired (`eb25374`). `apps/api` still has the connectors, but nothing in
the product reaches them. The drive vertical has none. Its version model leaves room for them
(`drive_file_versions.source`, `external_key`, `etag`), and reading such a version answers 501:
"connector reads are not wired yet"
([file-content.ts](../../apps/drive-vertical/src/file-content.ts)).

The immediate need is a3doc, the document box a gestoría shares with its client. Invoices
forwarded by email ([#357](https://github.com/markusahlstrand/canopy/issues/357)) end up there,
and the Qonto → a3doc sync writes into it.

## 2. The decision: Substrat's file-source shape, with the connector kept in this repo

The connector **lives in Canopy** (`packages/connectors/a3docs`) and is written against Substrat's
connector interfaces. Where it **runs** depends on the deployment:

- **Self-hosted drive:** the vertical's host calls `registerConnector` with it directly, and
  Substrat doesn't change.
- **Hosted drive** (`substrat push`, how it ships today): Substrat 0.164.0 and CLI 0.50.0
  support vertical-defined connectors (upstream D-64 / PR #2635). The vertical declares
  `canopy.a3doc` through `src/connectors.ts` and mounts it on `mountPlatformSurface`.
  The platform retains the sealed credential, bindings and schedule, and calls the provider
  code in the vertical's worker with a `ScopedConnectionContext`. Network access uses the
  vertical's declared `outbound` hosts. No control-plane registration or npm publication is
  needed: the workspace package is bundled into the vertical.

The shared sync and upload engines still support the original self-hosted interfaces. Hosted
sweeps use smaller pages (25 documents, one page per call) to stay below the platform's limit
of 100 recorded outbound uses. Upload attempts are journalled through the connector-only
`drive/source-write-journal` operation **before** the provider call: ordinary connector-state
writes are committed only on success and cannot preserve an attempt whose response was lost.
The journal carries file ids, hashes and document ids, never credentials.

The landing keeps identities in `drive_source_items`, keyed by `(connection_id, item_id)` and
pointing at ordinary file/folder rows. Local uploads staged by `drive/send-source-file` are
adopted on their echo. Repeated attachment content is a no-op, including a retry that uploaded
identical bytes under a different attachment id after losing call-state. Unreferenced duplicate
or rejected attachments remain eligible for the platform's ordinary orphan sweep; no module
writes the kernel's attachment tables.

The settings UI, per-space opt-in/folder selection, connected-space mutation restrictions,
write-failure display, and the live account check remain follow-up work in #358. This is not yet
an end-to-end user-facing connected-space feature. The manifest's automatic landing currently
uses the root folder on the platform's primary active install; it does not implement per-space
folder preferences.

Substrat already has the shape for a source that holds files
([connections.md §6.3](https://github.com/substrat-run/substrat/blob/main/docs/architecture/connections.md),
[rfc/file-bearing-sources.md](https://github.com/substrat-run/substrat/blob/main/docs/rfc/file-bearing-sources.md),
`@substrat-run/contracts` `file-source.ts`):

- **Reads are a sync that copies bytes in.** The connector sends `fileSourceChange` rows (upsert,
  content or delete, keyed by `itemId`) to an operation the vertical declares. The bytes arrive as
  **attachments** on the entity that operation names. So a connected file is an ordinary
  `source: 'blob'` version, and downloads, previews, offline and search work without changes. The
  one exception is a file over `FILE_SOURCE_MAX_FILE_BYTES` (50 MB), which lands **without bytes**
  (`content: 'too-large'`). It becomes a file row with no version and a durable
  `source_status: 'too-large'` (§4.2), never an `external` version. So the 501 path is never used.
- **Writes are events.** The vertical emits the provider's write event with a
  `fileSourceWriteRequest` payload (attachments plus `directory` plus a required `conflict`).
- **Credentials** come from the vertical's own settings screen through the connection relay
  (connections.md §3.5.2) and are stored in the connection store.
- **Binding.** The vertical declares in its manifest
  `connections: [{ provider, operation, permission, options }]`. The platform sweep then binds each
  connection of that provider to the scope through the provider's `bindScope` (#2316).

A drive **space is its own scope**, so "this space is backed by that a3doc account" is exactly one
binding.

The `StorageConnector` written for `apps/api` (branch `feat/connector-a3docs`) is not the
product path. Its `client.ts` stays as the base of the new package: the dependency-free WebAPI
client and the quirks verified against a live account (§3.1).

## 3. Canopy: `packages/connectors/a3docs`, Substrat file source #2

### 3.1 What the API gives us

These calls come from a3doc's own web app bundle. Reading was verified live; uploading was not.

- `signIn {tenant, user, password, devicePlatform: 13, deviceType: 0}` → `token`. The company's
  endpoint is found first via `GET <address-provider>/v1/Address/<companyCode>`.
- `ContainersTree` → the folder tree. The root is container `1` ("Todos"), and leaves carry
  `children: null`.
- `GetDocumentsExtended {containersIdsToSearch, searchChildContainers, pageIndex, pageSize,
  Order: "dateModified", Sort: "desc"}`. The root container ignores `searchChildContainers:
  false`.
- `Download {documentId}` → base64 `content`.
- `Upload {containersIds, content, customerId, extension, title, date: null}` → `documentId`.
  It always adds a new document.
- **No delete, rename, move or create-folder.** Every answer is HTTP 200 with an `errorCode`;
  `6` means the token is invalid. `Size` is in KB, and dates are Spanish wall-clock time.

### 3.2 Mapping onto the file-source contract

**Naming.** The package is `@canopy/connector-a3docs` in `packages/connectors/a3docs`, the
directory the `feat/connector-a3docs` branch already uses. The **provider id** stays `a3doc`,
because it's the product's name. So does the write event, `a3doc.files-requested`.

| Contract | a3doc |
|---|---|
| connection credential | company code, user and password, through the relay. The probe is `signIn` followed by `UserInfo`. It reports whether the role may upload (roles 1 and 6 may not), and the bind records that on the binding as `canUpload`. |
| binding `folder` | a container path. Default: the root |
| `itemId` (file) | `<documentId>@<containerId>`. A document filed in two containers appears twice, as two items. |
| `itemId` (folder) | `c<containerId>` |
| names | `<Title>.<ext>`, with slashes turned into `-`. **A name, once given to an item, is kept** in connector state (`itemId → name`) and changes only when that document's own title changes. When titles clash, the item that arrives later gets `(<Code>)` appended. Removing a sibling never renames another item, so a path never depends on its neighbours. A document the connector uploaded itself is given the `name` its write request asked for (found through the write ledger), which is what lets the vertical adopt its own upload (§4.3). |
| `lastModifiedAt` | `DateModified`, read as Europe/Madrid time |
| change feed | a3doc has none. Read newest-modified first and stop once `DateModified` is **older than the high-water mark minus an overlap window** (2 hours). Compare with `>=`. The window covers the repeated hour at the October DST change and ties on the high-water value. a3doc exposes no revision and no offset-bearing instant, so wall-clock `DateModified` is **not** a safe version key on its own. The connector keeps a per-item fingerprint (`DateModified` + `Size` + `Title`) and re-lands an item whenever any part changes. An item whose `DateModified` falls in an ambiguous (repeated) hour is not trusted on its fingerprint: the next daily full walk downloads it and compares its sha256 with the landed attachment's, landing new content on a mismatch. Re-sent changes are harmless because the landing is idempotent (§4.2). |
| delete | only on an answer about that item. For `<doc>@<c>`, ask `GetDocumentsExtended` scoped to container `c` and filtered to the document's `Code`. If it's there, it's held. If it's gone from `c` but `Download {documentId}` still answers, it's `moved-out`. If `Download` fails as gone, it's `deleted`. A walk's silence is never enough (the RFC's fourth invariant). |
| write event | `a3doc.files-requested`. `conflict: 'rename'` uploads a new document (a3doc keeps both). `'fail'` checks for the name and then uploads. That is **best-effort**: a3doc has no atomic create-if-absent, so two writers (or a person in a3doc's web app) can both pass the check. `'replace'` is refused at validation. **The write ledger** keys on the request's attachment. It records `attempted` (with the target container, title and attachment sha256) *before* calling `Upload`, and `documentId` after. `Upload` has no idempotency key, so a retry whose ledger row says `attempted` without a `documentId` (the response was lost) **reconciles before uploading again**. It searches the target container by title (`GetDocumentsExtended` with the title filter the web app uses, `AttributeId: 3`) for documents created since the attempt, downloads each match, and adopts the one whose sha256 equals the attachment's: its `documentId` is recorded and no second upload happens. Only when no match exists does it upload again. A same-titled document a person added with different bytes is never adopted. |
| upload customer | binding option `customerId`. When absent, the customer the bound documents already carry. |

### 3.3 What this asks of the platform

- **Q1 (where the walk runs).** Committing a second provider is one of the RFC's triggers for
  deciding it. This note doesn't decide it. a3doc is small (hundreds of documents) and can ship the
  way Microsoft 365 did (cursor and name map in connector state, its own bind) without blocking on
  the facet. It then becomes the second implementation the `FileSource` facet is extracted from.
- **Q2 (read-only).** It lives on the binding. An a3doc binding is read-write only when the probe
  says the role may upload (`canUpload`); otherwise it is read-only. Even read-write only allows
  adding.
- Nothing changes under `/internal/connections/*`.

## 4. Canopy: connected spaces in the drive vertical

1. **Permission and manifest.** Add `drive:land-source` to `DRIVE_PERMISSIONS`
   (`packages/scope-drive/spec/model.ts`; today it is only read, write and manage). No human role
   holds it, so provisioning gives it to no role. The landing declaration is what grants it to the
   connection, which #2316's bind verifies. `scope-drive` declares
   `connections: [{ provider: 'a3doc', operation: 'drive/land-source-change', permission:
   'drive:land-source' }]`. Later sources (Synology, GitHub, Microsoft 365) add rows here. They
   don't add new operations.
2. **The landing operation**, `drive/land-source-change`, receives one `fileSourceChange` per call.
   It is **keyed on `itemId`, never on path**. That needs a new column, `drive_files.source_item_id`,
   unique within the space (a trashed row keeps its value):
   - `upsert` with a known `itemId` on a **live** row: if `path` differs, rename or move that same
     row. Its id, versions and links survive. With a known `itemId` on a **trashed** row (the
     document came back into the folder): restore that row, then apply the path. With an unknown
     `itemId`: first try to **adopt** (§4.3), then create a row. When `content: 'follows'` it
     answers `{ entity }` naming the file. When `content: 'too-large'` the row gets
     `source_status: 'too-large'` and no version, and any earlier version stays current (or there
     is none). The drive then shows "Too large to copy from a3doc (over 50 MB)" in place of
     download and preview, leaves the file out of offline, and indexes its name only for search. A
     later upsert whose size is under the cap clears the status and asks for the bytes.
   - `content`: **guarded by `replaces`.** The landing compares `replaces` with the file's current
     state. If the file has no current version, `replaces` must be `null`. Otherwise it must equal
     the current version's `blob_ref`. When it matches, insert a `drive_file_versions` row
     (`source: 'blob'`, `blob_ref` = the landed attachment) and repoint
     `drive_files.current_version_id` to it, passing that current version as
     `expectedCurrentVersion` so a concurrent write fails rather than overwrites. History is the
     earlier version rows of that file (`file_id`); there is no `replaces` column. When the landed
     attachment is already the current `blob_ref` (a redelivery), it is a no-op. On any other
     mismatch the change is **stale** and is rejected: no version is written, and the landing
     removes the newly landed attachment so nothing points at orphaned bytes. The newer content
     the file already has is never replaced by an older one.
   - `delete` (`deleted` or `moved-out`): looks the `itemId` up among **live** rows only. If the
     row is already trashed, or there is none, the delete is a **no-op**, so a redelivered delete
     never renames or trashes anything twice. On a live row: **free the name, then trash.** A
     trashed file keeps its name, because `(folder_id, name)` is unique regardless of state
     (model.ts). So the row is first renamed to `<stem> (removed <short itemId>).<ext>`, then
     trashed. A later document with the same title can then land under the plain name. The delete
     applies to that one file and never cascades through a folder.
3. **Uploads are adopted, never duplicated.** This is required. An upload into a connected folder
   creates a local `drive_files` row with no `source_item_id`, marked as pending for the
   attachment it carries. It must land under a name free in that folder, or `(folder_id, name)`
   refuses it on the spot. The operation then emits `a3doc.files-requested` with that exact
   `name` and `conflict: 'rename'`. When the sync lands the new document, its name is the one
   requested, because the connector's name map honours the requested name. The landing finds the
   pending row in the same folder with that name and **adopts** it: it sets `source_item_id`
   instead of creating a second row, which `(folder_id, name)` would refuse anyway. A pending row
   whose write the connector reports as failed is marked failed and shown, never left looking
   synced.
4. **Connecting a space.** (Built for the space settings; the create-space step is not.) The space settings get a new *Source* section (or the create-space
   dialog a *Connect a source* step). It shows the provider's credential fields and posts them
   through a vertical operation that calls the connection relay. It is gated on `drive:manage`.
   The space shows the source, when it last synced (from the binding's `lastSync`), whether
   uploads are allowed, and errors from the connection's sweep.
5. **What a connected space allows.** Upload into an existing folder, **only when the binding's
   `canUpload` is true**. Otherwise uploads are refused up front with the reason ("this a3doc user
   can't upload"), so a file is never stored locally that can never reach a3doc. New folders,
   rename, move and delete are always refused, in both the UI and the operations, because a3doc
   can't do them. The refusal says why.
6. **Leaving and rebinding.** Unbinding keeps the files (RFC Q4 = keep), and the space becomes an
   ordinary space. The kept rows **keep their `source_item_id`**, and the space records which
   account they came from (the connection's `externalAccountRef`, the a3doc company code). A later
   binding to the **same account** resumes those identities: its first sync finds them by
   `itemId`, so nothing is landed twice. A file given a new version in Canopy while unbound no longer
   matches the `replaces` a3doc sends, so a3doc's next content for it is rejected as above. The
   file is marked `source_status: 'diverged'` and shown as such, and nobody's edit is silently
   overwritten in either direction. A binding to a **different account** is
   allowed only after the old identities are cleared. That bind clears every `source_item_id` in
   the space first, so the old files stay as ordinary files and can never be mistaken for, or
   overwritten by, the new account's documents.

## 5. Sequence

Each step is its own PR.

| # | Repo | What |
|---|---|---|
| 1 | canopy | `packages/connectors/a3docs`, rebuilt as a Substrat connector: the client from `feat/connector-a3docs`, credential and probe (`canUpload`), bind/list/unbind, sweep to `fileSourceChange` (name map, overlap cursor, fingerprints with a content check for ambiguous-hour items, per-container delete check), write handler and a ledger that reconciles lost upload responses. It exports a `ConnectorRegistration`, is tested against a fixture provider, and builds to `dist` the way `@canopy/scope-drive` already does (`tsconfig.build.json`, `main: ./dist/src/index.js`). It is the first Canopy package to be **published** (see §6.4). |
| 2 | canopy | Done: use Substrat 0.164.0 / CLI 0.50.0 vertical-defined connectors; declare `canopy.a3doc` and bundle the provider with the worker. No upstream registration is needed. |
| 3 | canopy | `scope-drive`: `drive:land-source` in `DRIVE_PERMISSIONS`, the `connections` manifest row, `source_item_id` and `source_status` (`too-large` / `diverged`) with their migration and unique index, `drive/land-source-change` (keyed on `itemId`, adopt, restore-on-return, `replaces`-guarded content with stale-attachment cleanup, idempotent free-then-trash delete), the account recorded per space for rebinding, pending-upload rows, and the write operation that emits the event |
| 4 | canopy | drive UI: *Source* in the space settings (connect, status, last sync, upload allowed), and connected-space affordances (upload only, and only with `canUpload`) |
| 5 | both | live check against a real a3doc account, including **one agreed test upload**, since a3doc has no delete |

Synology and GitHub come back the same way afterwards. They are steps 1–2 again for each
provider, and that is when the shared `FileSource` facet is worth extracting.

### 5.1 S3 (second file source, built)

`packages/connectors/s3` (`canopy.s3`) is the second provider on this path, and the first
read-write one. Where it differs from a3doc:

- **Item ids are object keys** (folders: the key with a trailing `/`), so a retried sweep never
  mints a second identity. A move made from Canopy keeps its ids through a `s3:moves` entry in
  `drive/source-write-journal`, written before the copy.
- **Reads** list the prefix in key order (`start-after` cursor), compare ETags, and are cut into
  calls by a download budget. Deletes land only after a `HEAD` (file) or one-key listing (folder).
- **Writes** cover all three conflict modes (create-only PUTs with `If-None-Match: *`, and an
  `x-amz-meta-canopy-write` tag so a retry recognises its own object) plus delete, move and mkdir
  through a second event, `s3.items-requested`, because `fileSourceWriteRequest` only adds files.
  That event's vocabulary is the candidate to lift into Substrat's contract once Synology needs it.
- **No echo:** a file sent from Canopy is landed with its own attachment, not downloaded back.

Still open for S3: the drive UI (the *Source* section, step 4) and routing the drive's own
rename / move / trash / create-folder in a bound space through `drive/request-s3-change`.
A provider that ignores `If-None-Match` (older MinIO, some B2 setups) turns `fail` into overwrite.

## 6. Open questions

1. **The extension format on `Upload`.** The web app sends `entireExtension.toLowerCase()`, so
   probably `.pdf` with the dot. This needs confirming in the step-5 upload.
2. **The cost of the delete check.** One scoped `GetDocumentsExtended` per held item per pass is
   fine at hundreds of documents. At thousands, the check should run in batches spread over
   passes, with a budget.
3. **Reporting a failed write back to the vertical.** §4.3 needs the connector to say when an
   upload failed for good. Is that a `fileSourceChange` the contract lacks today, or the write's
   dead-letter as Microsoft 365 already reports it?
4. **Publishing.** `@canopy/scope-drive` shows how to build a Canopy package, but it is
   `"private": true`. Nothing in Canopy has been published yet. Is it an npm publish of
   `@canopy/connector-a3docs`, or does Substrat vendor a pinned tarball? It depends on what the
   control plane's deploy accepts. **Resolved:** vertical-defined connectors bundle the workspace package; publishing is optional for reuse.
5. **Many spaces, one account.** Binding one a3doc connection into several spaces (say, per
   container) needs the binding `folder` option set per scope, not from the manifest. Is that a
   platform change (#2316 binds from a manifest-wide declaration)?
   **Resolved** by substrat#2732 (Substrat 0.170): the landing is `bind: 'on-request'`, so the
   platform's pass binds nothing for it. Each space upserts its **own** connection
   (`owner: 'scope'`) and binds it with its own `folder` through the vertical-host clients
   (`upsertConnection`, `bindConnection`, `unbindConnection`, `listBindings`). Two spaces on one
   a3doc account hold two connections. Built in `apps/drive-vertical/src/source-routes.ts`
   (`PUT`/`DELETE /api/source`, `GET /api/source/status`); `drive/source-access` is the
   `drive:manage` decision, and `drive_source` (migration 0013) records the binding in the space.
