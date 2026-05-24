# Document AI

Automatically labels each document by type using an AI model.

## What it does

Document AI is a **processor**: when a file is added or changes, a server-side hook reads it,
asks an AI model to classify it (invoice, contract, receipt, …), and writes that type back
to the file's metadata. Its detail view is an **activity feed** of recent runs across your
files, and the per-file result also shows in each file's details. It runs on whichever AI
provider is configured — Gemini Flash, an OpenAI-compatible endpoint, or Cloudflare Workers
AI — without code changes; add your own key under **Settings → AI models**.

## At a glance

- **Type:** App (processor + detail view)
- **Contributes:** a detail view; a server-side processing hook that enriches items
- **Capabilities:** `item:read` and `item:write` (the type label), plus `net:fetch`
  restricted to `generativelanguage.googleapis.com` for Gemini
- **Availability:** in the store, not installed by default
- **Category:** Productivity

## See also

- [How plugins work](how-plugins-work) — processors and the enrich-on-change role.
- [Storage and files](storage-and-files) — where derived metadata lives.
