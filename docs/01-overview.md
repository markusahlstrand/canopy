# Overview

Canopy is an extensible, gsuite-style portal. The first app is a **drive** — a file
manager backed by a real storage service. Over time the same shell is meant to host more
apps: calendars, tasks, notes, budgets.

The drive has **two content origins**: a *managed* drive where Canopy owns the bytes
(content-addressed and de-duplicated), and *connected* drives where you point Canopy at a
filesystem / S3 / R2 you already own and it **indexes** them in place. Either way the
database — file records, versions, permissions — is what the UI talks to.

The guiding idea is a **slim core with everything else as plugins**. Storage backends are
plugins; the core knows how to talk to a connector and how to render a plugin's
contributions — it does not know what S3 is, or what a calendar is.

## Why it's built this way

- **Adapters everywhere, Cloudflare-first.** Like authhero, Canopy is designed to deploy
  anywhere through adapters, with Cloudflare Workers as the primary target. The same code
  runs locally on Node (and in Docker) for development.
- **Your storage, your choice.** Use the managed drive (Canopy stores the bytes, content-
  addressed and de-duplicated) or connect a bucket/folder you own and have Canopy index it
  in place. The product is "a small piece of well-made furniture" for a household, not
  another cloud silo.
- **Two kinds of plugins, kept separate.** Storage connectors are trusted, typed I/O.
  Extension plugins add UI and behaviour and are meant to run as sandboxed, dynamic code.
  Conflating them would mix two very different security models — see
  [How plugins work](how-plugins-work).

## What works today

This repo is early. To keep these docs honest, here's the current line between built and
planned.

**Built:**

- `@canopy/core` — storage-connector, plugin-runtime, registry, and contribution interfaces.
- `@canopy/store` — the **DB-backed managed drive**: content-addressed blobs with per-tenant
  dedup + reference counting, file records, versions, and permissions. Adapters for **D1 + R2**
  (Cloudflare) and **libsql + filesystem** (Node).
- `@canopy/api` — a portable Hono server exposing the drive (`/uploads`, `/files`) plus read-only
  `docs`/`demo` mounts over a `StorageConnector`.
- Connectors: `@canopy/connector-local`, `@canopy/connector-r2`, and read-only
  `@canopy/connector-github` (serves the docs + demo drive from a repo).
- **OIDC / authhero** auth (BFF with an encrypted cookie session) and **single-Worker Cloudflare
  deployment** (Static Assets + D1 + R2), plus a Node/Docker single-process mode.
- **Sharing & spaces** — relation-tuple (Zanzibar-lite) access control: per-file grants + shared
  **spaces** (a family is a group space that appears as a folder inside My Drive), share-by-email
  with pending invites, and roles (owner/editor/viewer).
- `@canopy/portal` — the Vite + React SPA (desktop + mobile), with first-party Calendar, Tasks,
  and Docs plugins, **sandboxed file viewers** (image, PDF, a Markdown editor), and `@canopy/plugin-sources`
  for resolving plugins from GitHub/npm/zip.

**Planned (designed, not yet implemented):**

- **Connected/indexed storage** — pointing the drive at an existing filesystem / S3 / R2 and
  crawling it into the index (Cloudflare **Workflows** on the edge, an in-process runner on Node).
  The data model already supports it (a version can be a managed blob *or* an external pointer).
- The dynamic plugin **runtime/sandbox** for *server* hooks (Worker Loader, `isolated-vm`) and
  **capability enforcement**. Today's first-party plugins run in-process; the client-UI sandbox
  (file viewers) is already built.
- Vector and full-text search over the index.

Anything marked _planned_ is design intent, not running code.

## Where to go next

- [Architecture](architecture) — the monorepo, the core interfaces, how a request flows.
- [Storage & files](storage-and-files) — blobs, files, versions, dedup, and virtual folders.
- [Sharing & spaces](sharing-and-spaces) — spaces, roles, share-by-email, and the access model.
- [How plugins work](how-plugins-work) — the plugin model, contributions, capabilities.
- [Writing a plugin](writing-a-plugin) — a hands-on walk-through using this very Docs plugin.
