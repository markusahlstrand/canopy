# Overview

Canopy is an extensible, gsuite-style portal. The first app is a **drive** — a file
browser over storage you bring yourself (local disk, S3, R2). Over time the same shell
is meant to host more apps: calendars, tasks, notes, budgets.

The guiding idea is a **slim core with everything else as plugins**. Even the storage
backends are plugins. The core knows how to talk to a connector and how to render a
plugin's contributions — it does not know what S3 is, or what a calendar is.

## Why it's built this way

- **Adapters everywhere, Cloudflare-first.** Like authhero, Canopy is designed to deploy
  anywhere through adapters, with Cloudflare Workers as the primary target. The same code
  runs locally on Node (and in Docker) for development.
- **Bring-your-own storage.** Canopy never holds your files. You point it at a bucket or a
  folder; it indexes and presents them. The product is "a small piece of well-made
  furniture" for a household, not another cloud silo.
- **Two kinds of plugins, kept separate.** Storage connectors are trusted, typed I/O.
  Extension plugins add UI and behaviour and are meant to run as sandboxed, dynamic code.
  Conflating them would mix two very different security models — see
  [How plugins work](how-plugins-work).

## What works today

This repo is early. To keep these docs honest, here's the current line between built and
planned.

**Built:**

- The `@canopy/core` interfaces — storage connectors, the plugin runtime contract, the
  registry, and declarative UI contributions.
- `@canopy/connector-local` — a storage connector over the Node filesystem.
- `@canopy/api` — a portable Hono server that mounts connectors and exposes them over HTTP.
  It supports multiple **mounts** (e.g. your drive plus a read-only `docs` mount).
- `@canopy/portal` — the Vite + React SPA implementing the drive UI, with first-party
  Calendar, Tasks, and Docs plugins driven through the registry.
- URL-based navigation (refresh and back/forward work), upload, and delete.

**Planned (designed, not yet implemented):**

- The dynamic plugin **runtime/sandbox** (Cloudflare Worker Loader, `isolated-vm` for Node)
  and **capability enforcement**. Today's first-party plugins run in-process as host
  components; the manifests and capabilities are real, but nothing sandboxes them yet.
- More connectors (`@canopy/connector-r2`, S3).
- A SQL **index** of files, with vector and full-text search later.
- Auth via OIDC / authhero, and Cloudflare Worker deployment.

Anything marked _planned_ below is design intent, not running code.

## Where to go next

- [Architecture](architecture) — the monorepo, the core interfaces, how a request flows.
- [How plugins work](how-plugins-work) — the plugin model, contributions, capabilities.
- [Writing a plugin](writing-a-plugin) — a hands-on walk-through using this very Docs plugin.
