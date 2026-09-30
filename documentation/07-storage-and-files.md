# Storage & files

The current drive's primary records live inside a Substrat scope: one scope per space. A folder row has a parent edge and a path; a file row names its folder and current version; a version row names its content. No drive table needs a tenant or space ID because the scope is the boundary.

## File tree and versions

Folders are real rows, including the root and empty folders. Creating or moving a folder updates its parent relationship, which the permission checker uses to walk grants. A file can be renamed, moved, moved to Trash, and restored. A content upload creates a new version and points the file at it. The vertical can list version history; restore of a previous version, pinning, and retention pruning are still legacy features and are not exposed there.

The module defines these rows and operations in <code>packages/scope-drive</code>. The app's listing and preview are in <code>apps/drive-vertical</code>.

## Bytes

The vertical writes managed bytes through Substrat's attachment surface into a per-tenant blob store. The file row exists first so the attachment can bind to it. The host hashes and stores the bytes; <code>drive/record-version</code> then verifies the attachment row and records its size and MIME. A read resolves the current version and opens the attachment with the kernel's file permission gate. The upload route currently limits a body to 25 MB.

The schema can describe an external version by key and etag, but the vertical has no connected-source byte reader yet. Legacy <code>@canopy/store</code> used content-addressed blobs with deduplication and reference counts. Those are facts about the old store, not guarantees of the current attachment path.

## Search and extraction

The kernel indexes declared entity fields: file names and <code>file_text.text</code>. After a PDF upload, the worker attempts extraction and records one of <code>indexed</code>, <code>empty</code>, <code>unsupported</code>, or <code>failed</code> for the current version. No row means extraction has never been attempted. Search returns matching files under the caller's scope permissions.

Extraction runs after the upload response. If a file predates it, or that background work is lost, its content stays unindexed until the [durable backfill](https://github.com/markusahlstrand/canopy/issues/66) lands. Semantic search is [separate work](https://github.com/markusahlstrand/canopy/issues/57).

## Remaining migration

The old API and store still implement a shared-database drive, WebDAV, offline change feeds, retention, and connected-storage mechanisms. The vertical does not inherit those routes automatically. [S9](https://github.com/markusahlstrand/canopy/issues/48) extracts document capabilities into the scope model; [S10](https://github.com/markusahlstrand/canopy/issues/49) covers existing data and retirement of the old storage path.
