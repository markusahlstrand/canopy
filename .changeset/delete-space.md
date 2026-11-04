---
"@canopy/drive-vertical": patch
"@canopy/scope-drive": patch
---

Owners can delete a space. Space settings gains a "Delete space" section, armed by typing the space's name, backed by `DELETE /api/sites/:slug` and a new `drive/archive-space` operation (`drive:manage`) that asks the platform to archive the space it runs in through Substrat's `archive-scope` intent. Authority is checked in the space being deleted, never the selected one; the space leaves the switcher at once. The install's home space cannot be deleted.
