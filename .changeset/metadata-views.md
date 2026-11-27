---
"@canopy/scope-drive": patch
"@canopy/drive-vertical": patch
---

Saved metadata views: a space can show its documents as virtual trees grouped by category, label, year or month added, type or top folder, beside its real folders. Nothing is moved and no access changes. Owners make views and pick the default in space settings; each member can pick their own view (kept per space on the device). A document placed only by Document AI's unconfirmed category is marked. `drive/list-subtree-files` now also returns each file's category, who chose it, and its current type, and `GET /api/space-views` gives any member the views, the default and the category names.
