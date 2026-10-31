---
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

Connect a space to its own a3doc folder (#358, on Substrat 0.170's per-space binding, substrat#2732). The a3doc landing now binds on request, so the platform's regular pass no longer binds a3doc into every space. Space settings gain a Source section: a manager enters the a3doc login and folder, the worker stores the login as a connection the space owns and binds it with that folder through the platform relay, and the space records what it mirrors (`drive_source`, migration 0013; `drive/get-source`, `drive/source-access`, `drive/record-source`, `drive/clear-source`; `GET /api/source`, `GET /api/source/status`, `PUT` and `DELETE /api/source`). Disconnecting keeps every file. A connected space refuses new folders, renames, moves, deletes, restores and replacing a document, refuses uploads when the a3doc user can only read, and sends an allowed upload on to a3doc; the drive hides those actions to match.
