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

The connector **lives in Canopy** (`packages/connectors/a3doc`) and is written against Substrat's
connector interfaces. Where it **runs** depends on the deployment:

- **Self-hosted drive:** the vertical's host calls `registerConnector` with it directly, and
  Substrat doesn't change.
- **Hosted drive** (`substrat push`, how it ships today): a hosted vertical's module code may not
  fetch, and its connector deliveries and sweeps run in the control plane from the fixed
  `CONNECTORS` list (control-plane `worker.ts`). There, "the SAME closure a self-host registers
  runs unchanged". The platform holds the sealed credential and the network access, and it never
  runs code a vertical hands it at runtime. So Substrat **depends on the published
  `@canopy/connector-a3doc`** and adds one `ConnectorRegistration` for it. That is a
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

## 3. Canopy: `packages/connectors/a3doc`, Substrat file source #2

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

| Contract | a3doc |
|---|---|
| connection credential | company code, user and password, through the relay. The probe is `signIn` followed by `UserInfo`, which also reports whether the role may upload (roles 1 and 6 may not). |
| binding `folder` | a container path. Default: the root |
| `itemId` (file) | `<documentId>@<containerId>`. A document filed in two containers appears twice, as two items. |
| `itemId` (folder) | `c<containerId>` |
| paths and names | `<Title>.<ext>`. When titles clash, the oldest keeps the plain name and the others get `(<Code>)` appended. Slashes in names become `-`. |
| `lastModifiedAt` | `DateModified`, read as Europe/Madrid time |
| change feed | there is none. Read newest-modified first and stop at the cursor (the high-water `DateModified`), with a full walk as the fallback. |
| delete | only on an answer about that item: `Download` (or a by-`Code` filter) saying the document is gone. Never from absence in a walk, which is the RFC's fourth invariant. |
| write event | `a3doc.files-requested`. `conflict: 'rename'` uploads a new document (a3doc keeps both). `'fail'` checks the target name first. `'replace'` is refused at validation, because a3doc can't replace. |
| upload customer | binding option `customerId`. When absent, the customer the bound documents already carry. |

### 3.3 What this asks of the platform

- **Q1 (where the walk runs).** Committing a second provider is one of the RFC's triggers for
  deciding it. This note doesn't decide it. a3doc is small (hundreds of documents) and can ship the
  way Microsoft 365 did (cursor in connector state, its own bind) without blocking on the facet.
  It then becomes the second implementation the `FileSource` facet is extracted from.
- **Q2 (read-only).** It lives on the binding. a3doc bindings are read-write, but only adding is
  possible.
- Nothing changes under `/internal/connections/*`.

## 4. Canopy: connected spaces in the drive vertical

1. **Manifest.** `scope-drive` declares
   `connections: [{ provider: 'a3doc', operation: 'drive/land-source-change', permission:
   'drive:land-source' }]`. Later sources (Synology, GitHub, Microsoft 365) add rows here. They
   don't add new operations.
2. **The landing operation**, `drive/land-source-change`, receives one `fileSourceChange` per call
   and stores it by `itemId`, so it is idempotent:
   - `upsert` creates or updates the `drive_files` row at `path` and records `itemId` on it. When
     `content: 'follows'` it answers `{ entity }` naming that file.
   - `content` adds a version with `source: 'blob'` and `blob_ref` set to the landed attachment.
     `replaces` stays as the previous version, so version history works for free.
   - `delete` (`deleted` or `moved-out`) sends that one file to trash. It is never applied to
     everything under a folder.
3. **Connecting a space.** The space settings get a new *Source* section (or the create-space
   dialog a *Connect a source* step). It shows the provider's credential fields and posts them
   through a vertical operation that calls the connection relay. It is gated on the space's
   manage permission. The space shows the source, when it last synced (from the binding's
   `lastSync`), and errors from the connection's sweep.
4. **What a connected space allows.** You can upload into an existing folder: the attachment is
   stored, then the operation emits `a3doc.files-requested` with `conflict: 'rename'`. The file
   appears once the sync lands it back. New folders, rename, move and delete are refused,
   both in the UI and in the operations, because a3doc can't do them. The refusal says why.
5. **Leaving.** Unbinding keeps the files (RFC Q4 = keep), and the space becomes an ordinary space.

## 5. Sequence

Each step is its own PR.

| # | Repo | What |
|---|---|---|
| 1 | canopy | `packages/connectors/a3doc`: the client from `feat/connector-a3docs`, credential and probe, bind/list/unbind, sweep to `fileSourceChange`, write handler. It exports a `ConnectorRegistration` and is tested against a fixture provider. Published as `@canopy/connector-a3doc` (MIT). |
| 2 | substrat | depend on `@canopy/connector-a3doc` and add it to `CONNECTORS` in `apps/control-plane/src/connectors.ts` (inspector, sweeper, binder, dispatch), plus a connector doc page |
| 3 | canopy | `scope-drive`: the `connections` manifest row, `drive/land-source-change`, `itemId` on `drive_files`, and the write operation that emits the event |
| 4 | canopy | drive UI: *Source* in the space settings (connect, status, last sync), and connected-space affordances (upload only) |
| 5 | both | live check against a real a3doc account, including **one agreed test upload**, since a3doc has no delete |

Synology and GitHub come back the same way afterwards. They are steps 1–2 again for each
provider, and that is when the shared `FileSource` facet is worth extracting.

## 6. Open questions

1. **Upload echo.** The vertical stores an upload locally before a3doc has it. The sync then lands
   the same file as a new `itemId`. Should the write record the returned `documentId` so the
   landing can recognise its own upload? Otherwise a pending row and a landed row briefly coexist.
2. **The extension format on `Upload`.** The web app sends `entireExtension.toLowerCase()`, so
   probably `.pdf` with the dot. This needs confirming in the step-5 upload.
3. **Detecting deletes cheaply.** The RFC forbids inferring a delete from absence. Checking held
   items one `Download` at a time is expensive; filtering `GetDocumentsExtended` by `Code` may be
   cheaper. This needs probing.
4. **Publishing.** Canopy's packages are workspace-only today (`main: ./src/index.ts`). Step 1
   needs a build and an npm publish for this one package, or Substrat vendors a pinned tarball.
   Which does the control plane's deploy accept?
5. **Many spaces, one account.** Binding one a3doc connection into several spaces (say, per
   container) needs the binding `folder` option set per scope, not from the manifest. Is that a
   platform change (#2316 binds from a manifest-wide declaration)?
