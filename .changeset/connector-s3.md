---
"@canopy/connector-s3": minor
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

Add S3-compatible buckets (AWS S3, Cloudflare R2, MinIO, Wasabi, B2) as a Substrat file source for spaces. `@canopy/connector-s3` binds a space to a bucket prefix, syncs objects in by ETag with per-item delete checks, and writes back uploads (`replace` / `rename` / `fail`), deletes, moves and folders. The drive registers `canopy.s3`, adds `drive/send-s3-file` and `drive/request-s3-change`, and adopts a folder made in Canopy when the source reports it.
