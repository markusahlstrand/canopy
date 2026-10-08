# How Canopy compares

Canopy is an early drive built as a hosted Substrat vertical. The current product serves its own web app and API, stores file metadata per space, and keeps uploaded bytes in a per-tenant blob store. It supports folder navigation, upload, preview, name and PDF-content search, version history reads, and sharing by membership or folder grant.

| Alternative | What it offers today | Canopy's current difference |
|---|---|---|
| Google Drive, Dropbox, OneDrive | Mature sync clients, collaboration, broad integrations | A smaller, scope-isolated drive with its own hosted vertical and OIDC choice |
| Nextcloud, Seafile | Mature self-hosted file platforms | A platform-hosted Worker and scope model instead of a server you operate |
| Synology, TrueNAS | Storage hardware and NAS services | A web drive; connected NAS indexing is still migration work |
| Paperless-ngx | Document capture, OCR, and workflow | A general file tree with PDF and UTF-8 text extraction and durable backfill, without OCR |

Canopy does not currently offer desktop sync, real-time co-editing, WebDAV on the vertical, or connected-source reads there. It does offer a bundled plugin catalog and runtime imports from ZIP, public GitHub, and npm, subject to install review. Its older API and packages contain some other mechanisms, but they do not make them current vertical features. [Deployed plugin acceptance](https://github.com/markusahlstrand/canopy/issues/295) remains open; the document and storage migration is tracked in [S9](https://github.com/markusahlstrand/canopy/issues/48) and [S10](https://github.com/markusahlstrand/canopy/issues/49).
