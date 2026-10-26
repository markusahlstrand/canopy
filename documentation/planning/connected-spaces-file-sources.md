# Connected spaces on Substrat file sources

*Written 2026-10-26. This is a design note and nothing in it is built yet. It covers how the drive
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
- **Hosted drive** (`substrat push`, how it ships today): a hosted vertical's module code may not
  fetch, and its connector deliveries and sweeps run in the control plane from the fixed
  `CONNECTORS` list (control-plane `worker.ts`). There, "the SAME closure a self-host registers
  runs unchanged". The platform holds the sealed credential and the network access, and it never
  runs code a vertical hands it at runtime. So Substrat **depends on the published
  `@canopy/connector-a3docs`** and adds one `ConnectorRegistration` for it. That is a
  dependency plus a list entry. The connector's code is not copied.

Substrat already has the shape for a source that holds files
([connections.md §6.3](https://github.com/substrat-run/substrat/blob/main/docs/architecture/connections.md),
[rfc/file-bearing-sources.md](https://github.com/substrat-run/substrat/blob/main/docs/rfc/file-bearing-sources.md),
`@substrat-run/contracts` `file-source.ts`):

- **Reads are a sync that copies bytes in.** The connector sends `fileSourceChange` rows (upsert,
  content or delete, keyed by `itemId`) to an operation the vertical declares. The bytes arrive as
  **attachments** on the entity that operation names. So a connected file is an ordinary
  `source: 'blob'` version, and downloads, previews, offline and search work without changes. The
  501 path is never used.
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
| change feed | a3doc has none. Read newest-modified first and stop once `DateModified` is **older than the high-water mark minus an overlap window** (2 hours). Compare with `>=` and dedupe by `itemId` + `DateModified`. The window covers the repeated hour at the October DST change and ties on the high-water value, and the landing is idempotent, so re-sent changes are harmless. A full walk runs daily as the backstop. |
| delete | only on an answer about that item. For `<doc>@<c>`, ask `GetDocumentsExtended` scoped to container `c` and filtered to the document's `Code`. If it's there, it's held. If it's gone from `c` but `Download {documentId}` still answers, it's `moved-out`. If `Download` fails as gone, it's `deleted`. A walk's silence is never enough (the RFC's fourth invariant). |
| write event | `a3doc.files-requested`. `conflict: 'rename'` uploads a new document (a3doc keeps both). `'fail'` checks for the name and then uploads. That is **best-effort**: a3doc has no atomic create-if-absent, so two writers (or a person in a3doc's web app) can both pass the check. `'replace'` is refused at validation. The connector records each upload's returned `documentId` against the request's attachment (the write ledger). |
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
   unique within the space:
   - `upsert` with a known `itemId`: if `path` differs, rename or move that same row. Its id,
     versions and links survive. With an unknown `itemId`: first try to **adopt** (below), then
     create a row. When `content: 'follows'` it answers `{ entity }` naming the file.
   - `content`: insert a `drive_file_versions` row (`source: 'blob'`, `blob_ref` = the landed
     attachment) and **repoint `drive_files.current_version_id`** to it, the same way a normal new
     version does, with `expectedCurrentVersion` as the guard. History is the earlier version rows
     of that file (`file_id`); there is no `replaces` field to set.
   - `delete` (`deleted` or `moved-out`): **free the name, then trash.** A trashed file keeps its
     name, because `(folder_id, name)` is unique regardless of state (model.ts). So the row is
     first renamed to `<stem> (removed <short itemId>).<ext>`, then trashed. A later document with
     the same title can then land under the plain name. The delete applies to that one file and
     never cascades through a folder.
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
4. **Connecting a space.** The space settings get a new *Source* section (or the create-space
   dialog a *Connect a source* step). It shows the provider's credential fields and posts them
   through a vertical operation that calls the connection relay. It is gated on `drive:manage`.
   The space shows the source, when it last synced (from the binding's `lastSync`), whether
   uploads are allowed, and errors from the connection's sweep.
5. **What a connected space allows.** Upload into an existing folder, **only when the binding's
   `canUpload` is true**. Otherwise uploads are refused up front with the reason ("this a3doc user
   can't upload"), so a file is never stored locally that can never reach a3doc. New folders,
   rename, move and delete are always refused, in both the UI and the operations, because a3doc
   can't do them. The refusal says why.
6. **Leaving.** Unbinding keeps the files (RFC Q4 = keep), and the space becomes an ordinary space.

## 5. Sequence

Each step is its own PR.

| # | Repo | What |
|---|---|---|
| 1 | canopy | `packages/connectors/a3docs`, rebuilt as a Substrat connector: the client from `feat/connector-a3docs`, credential and probe (`canUpload`), bind/list/unbind, sweep to `fileSourceChange` (name map, overlap cursor, per-container delete check), write handler and ledger. It exports a `ConnectorRegistration`, is tested against a fixture provider, and builds to `dist` the way `@canopy/scope-drive` already does (`tsconfig.build.json`, `main: ./dist/src/index.js`). It is the first Canopy package to be **published** (see §6.4). |
| 2 | substrat | depend on `@canopy/connector-a3docs` and add it to `CONNECTORS` in `apps/control-plane/src/connectors.ts` (inspector, sweeper, binder, dispatch), plus a connector doc page |
| 3 | canopy | `scope-drive`: `drive:land-source` in `DRIVE_PERMISSIONS`, the `connections` manifest row, `source_item_id` (migration + unique index), `drive/land-source-change` (keyed on `itemId`, adopt, free-then-trash, repoint current version), pending-upload rows, and the write operation that emits the event |
| 4 | canopy | drive UI: *Source* in the space settings (connect, status, last sync, upload allowed), and connected-space affordances (upload only, and only with `canUpload`) |
| 5 | both | live check against a real a3doc account, including **one agreed test upload**, since a3doc has no delete |

Synology and GitHub come back the same way afterwards. They are steps 1–2 again for each
provider, and that is when the shared `FileSource` facet is worth extracting.

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
   control plane's deploy accepts.
5. **Many spaces, one account.** Binding one a3doc connection into several spaces (say, per
   container) needs the binding `folder` option set per scope, not from the manifest. Is that a
   platform change (#2316 binds from a manifest-wide declaration)?
