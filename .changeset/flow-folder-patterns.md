---
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

Flows file each document by its own folders. A "folder matches" check takes names from the path (`Client invoices/{year}/{month}`), and a copy uses them in a subfolder below its folder (`{year}/{month}`) and in a3doc categories typed by path. Folders that aren't there yet are made; in an a3doc space the one made in Canopy is taken up by a3doc's folder of that path when the document lands. New drive operation `drive/ensure-folder-path`.
