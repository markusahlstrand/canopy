---
"@canopy/scope-drive": patch
"@canopy/connector-a3docs": patch
---

Files landed from a source show when the source last changed them, not when they reached Canopy. a3doc's modified date was already sent with each document, but the drive ignored it. Documents already in a space are re-sent once, without their bytes, on the next daily full read, so their dates correct themselves.
