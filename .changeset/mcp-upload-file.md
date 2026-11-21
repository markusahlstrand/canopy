---
"@canopy/drive-vertical": patch
---

An assistant connected over MCP can now file documents. `drive_upload-file` takes a small file as base64 (up to 5 MB). `drive_create-upload-link` returns a one-time link, valid for 10 minutes, that an agent PUTs the raw bytes to (up to 25 MB), so large files never pass through the model. Both go through the same upload path as the app: only someone who may write the folder (an owner or editor) can upload, the type is taken from the name and must match the bytes, and in an a3doc space the document goes on to a3doc, filed in its folder and every `alsoIn` category. A name already in the folder returns the existing file and files nothing twice. Qonto spaces stay read-only. Uploaded files arrive for flows like any upload.
