---
"@canopy/drive-vertical": patch
"@canopy/scope-drive": patch
"@canopy/connector-a3docs": patch
"@canopy/connector-s3": patch
---

Opening a folder in a connected space checks it against its source in the background, so new, changed and removed documents show without waiting for the next sync. The listing shows what is already there at once; a line above it says "Checking a3doc for changes…", then "Checked just now", and a **Check now** button checks again on demand. A failure (a3doc down, MFA wanted) shows quietly on that line and never blocks the listing.

A folder is checked at most once a minute per space (`SOURCE_FOLDER_REFRESH_MS`, never under 10 seconds), and a second open while a check runs joins it. The drive records the request (`drive/request-folder-refresh`); the worker polls the source through the platform, which polls a binding at most once a minute itself. The a3doc and S3 connectors take the request at the start of their sweep and read only that folder's own children (`drive/source-folder-requests`, `drive/source-folder-checked`); Qonto, whose folders are its own date buckets, runs its ordinary pass. The a3doc connector keeps its signed-in session between calls for up to 30 minutes, so checking several folders signs in once.

The last full read now says why a space can hold more files than a3doc has documents: "all 280 documents read, 283 files here: a document can sit in more than one a3doc folder, and shows in each."
