---
"@canopy/scope-drive": patch
"@canopy/drive-vertical": patch
"@canopy/ui": patch
---

A processing list: the topbar's new Processing button (spinning, with a count, while anything is under way) opens a panel of what the space is working on in the background — reading a file's text, Document AI, people and companies, and flows — and what finished lately. Each run is named by its file and says where it is: queued, being worked on, waiting for its text or a daily limit, retrying (with why), done (with how it ended, e.g. "Skipped: there is no text to read") or failed. A "Label with AI" or "Find people and companies" request re-reads it at once, and its notice links to it. `GET /api/processing` serves it from the scope's job runs and only names files the caller can read, through the new `drive/resolve-files` (files by id or by attachment id, unreadable and trashed ones left out). The run's payload never leaves the server.
