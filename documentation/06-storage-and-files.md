# Storage & files

The drive is **database-backed**. The primary object is a *file record* — a row — not a
file; the bytes are a secondary thing the record points at. Three concerns stay strictly
separate:

- **Blob** — immutable bytes, identified by the **SHA-256 of their content**. Stored exactly
  once, with a reference count.
- **File** — a mutable record: id, tenant, owner, name, metadata, and a pointer to its
  *current version*. This is "the file" as you think of it.
- **Version** — binds a file to its content at a point in time.

A file's content can change (a new version) without touching its metadata, and its metadata
can change without creating a version. These are independent operations.

## Two content origins

A version's content is **polymorphic** — it's one of:

- **Managed (`blob`).** Canopy owns the bytes: content-addressed, de-duplicated, reference-
  counted, with the database as the source of truth. This is the default drive.
- **Connected (`external`) — in progress.** A pointer into a filesystem / S3 / R2 you own,
  indexed by object key + etag. There the bucket is the source of truth and the DB is an
  index over it.

Reads dispatch on the source: a managed blob streams from the blob store; an external
version is read through its connector.

## Metadata & virtual folders

`files.metadata` is a freeform **JSON column**. System-derived fields (size, mime) live on
the blob/version rows as real columns; everything else is schemaless. For keys that get
filtered often there are **expression indexes** on `json_extract(metadata, '$.key')` — JSON
plus indexes, never an EAV table.

Folders are **virtual**: a file's folder is just its `metadata.path` (e.g. `Documents/2026`).
Listing a folder returns the files at that path plus the child folder names derived from the
set of paths. Storage stays flat; the tree is computed. You can also create an **empty folder**
— it's recorded explicitly (a row in `folders`) so it shows up before it has any files, and is
merged into the derived tree.

## Uploading (content-addressed, de-duplicated)

```
1. browser hashes the bytes (SHA-256)
2. POST /uploads/prepare { hash }
     • hit  → the blob already exists; its ref_count is bumped — no upload
     • miss → returns an upload target
3. PUT /uploads/<hash>   (only on a miss)
     • the server RE-HASHES the received bytes and rejects a mismatch —
       the client's hash is never trusted as the key
4. POST /files { name, hash, path }   → file record + first version
```

Replacing content is `POST /files/:id/versions` (a new version, metadata untouched); editing
properties is `PATCH /files/:id/metadata` (no new version). Deleting a file soft-deletes the
record and releases a blob reference per version; the bytes are removed only when a blob's
`ref_count` reaches **0**.

## Dedup is per-tenant

The blob's storage key is namespaced **`<tenant>/<sha256>`** (tenant = the signed-in user's
`sub`), so identical bytes de-duplicate only *within* one tenant. Global, cross-tenant dedup
would let one tenant detect that another already stored a given file, so it's an explicit
opt-in (`CANOPY_GLOBAL_DEDUP=1`), off by default.

## Exporting metadata (`?embed=true`)

`GET /files/:id/content?embed=true` is meant to project a subset of metadata back into the
file on the way out — XMP for images/PDF, core properties for `.docx` — where the format
supports it, and return the raw bytes otherwise. The flag is wired; per-format projection
currently passes the bytes through unchanged.

## Adapters

The drive runs on **D1 + R2** on Cloudflare and **libsql (SQLite) + the filesystem** on
Node/Docker, behind `Db` and `BlobStore` interfaces. The schema is applied by a numbered,
forward-only migration runner on boot.

## Connecting a device (WebDAV)

The drive is also reachable over **WebDAV** at `/dav`, so you can mount it in Finder
(*Go → Connect to Server…*), Windows Explorer, or any WebDAV client. This phase is
**read-only** (`OPTIONS`, `PROPFIND`, `GET`/`HEAD`); write verbs come later.

The mount root mirrors the app: your personal files and folders at the top level, with each
**group space** you belong to appearing as a sub-collection. Virtual folders (`metadata.path`)
become real directory levels over the protocol, and a file's bytes stream from its current
version.

Clients can't carry an OIDC session, so WebDAV authenticates with **app passwords** instead
— per-device Basic-auth tokens you mint in *Connect a device…* (the account menu). The token
is shown **once** on creation and stored only as a SHA-256 hash; sign in with any username and
the token as the password. Revoke a device anytime and that mount stops working immediately.
