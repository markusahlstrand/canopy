---
"@canopy/scope-drive": patch
"@canopy/drive-vertical": patch
---

A new all-files view, switched with an icon beside list/grid, shows every file at or below the current folder with its category (folder path), labels and modified date. It is backed by `drive/list-subtree-files` (`GET /folders/{folderId}/all-files`), which needs read on that folder.
