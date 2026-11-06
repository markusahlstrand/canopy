---
"@canopy/drive-vertical": patch
---

The create-space dialog's Storage section is now a choice: Canopy storage or an a3doc folder. Picking a3doc shows the same login fields as space settings. The login stays in memory until the space request is done, then connects the new space through `PUT /api/source`. If a3doc refuses, the space is kept as an ordinary one and the dialog offers to open it.
