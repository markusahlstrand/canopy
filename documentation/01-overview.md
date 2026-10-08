# Overview

Canopy is a drive built as a [Substrat](https://github.com/substrat-run/substrat) vertical. Its browser app and API ship together in <code>apps/drive-vertical</code>. Each space is an isolated scope with its own file and folder records; the kernel supplies scope routing, permissions, attachments, search, and the event spine.

## What works today

- The drive lists folders and files across spaces available to the signed-in person. It supports uploads, downloads, rename, move, trash, restore, and folder sharing.
- File preview handles images, PDF, and text in the browser. Text files can be edited with revision checks. Version history is readable. Search matches names, current extracted content, descriptions, and labels.
- OIDC signs people in. The install has an owner, members can be invited, and folder grants use the kernel permission checker.
- Uploaded bytes use the platform attachment surface and a per-tenant blob store. Metadata and the file tree live inside the space's scope.
- A bundled plugin catalog offers viewers and editors. People can review and install plugins personally or for a space, including imports from ZIP, public GitHub, and npm. Runtime plugin source runs in an opaque-origin iframe.
- The browser mirrors file and folder names for offline browsing after a completed sync. File content, search, and writes still require a connection.

The source of truth for those features is <code>@canopy/scope-drive</code> in <code>packages/scope-drive</code>. The hosted worker and SPA live in <code>apps/drive-vertical</code>. See [Architecture](02-architecture.md) and [Storage & files](07-storage-and-files.md).

## Work still in progress

- [Deployed UI acceptance](https://github.com/markusahlstrand/canopy/issues/78) is still in progress. The legacy portal's full plugin ecosystem has not been migrated, even though the drive has a runtime installer and viewer host.
- Connected storage, semantic search, WebDAV, and migration of data from the old shared database have not moved to the vertical. See [the convergence rail](planning/substrat-extraction-tickets.md).

The repository still contains <code>apps/api</code>, <code>@canopy/store</code>, and connector packages. They are legacy or extraction inputs while the migration continues; they do not serve the current drive UI. Their presence does not mean a feature is available in the vertical.

## Where to go next

- [Architecture](02-architecture.md) — the running vertical and its kernel boundary.
- [Storage & files](07-storage-and-files.md) — the current file, version, and byte paths.
- [Deploying](06-deploying.md) — local development and the Substrat push path.
- [Sharing & spaces](08-sharing-and-spaces.md) — historical design; verify a feature against the scope module before relying on it.
