---
"@canopy/drive-vertical": patch
---

File content streams from storage instead of being loaded whole, and a `Range` request reads only the bytes it asks for, so seeking in a long video or opening a large PDF no longer holds the whole file in the worker. Responses carry the content hash as an `ETag`, and `If-Range` is honoured against it.
