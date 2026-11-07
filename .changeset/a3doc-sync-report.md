---
"@canopy/drive-vertical": patch
"@canopy/scope-drive": patch
"@canopy/connector-a3docs": patch
---

An a3doc space now says what its last sync found. Each full read keeps a report (documents a3doc listed, documents read, documents skipped because a3doc files them outside the bound folder, and files held) through the source journal, `drive/get-source` and `/api/source/status` return it, and space settings and the empty folder view show it, along with any sync failure. The report holds counts and a3doc folder ids, never document names.

The a3doc folder field also accepts a path that starts at the root name a3doc shows ("Todos"), which used to be refused.
