# Nextcloud

> The mature, self-hosted "content collaboration platform" — Canopy's closest cousin in spirit.

## What it is

A self-hosted PHP application with a large app ecosystem: files + sharing, plus Talk (calls),
Office (Collabora / OnlyOffice), calendar, contacts, and hundreds of community apps. It runs on
your server / VM with a database, and has well-established desktop-sync and mobile clients.

## Where it beats Canopy

- Maturity and breadth: years of development, a huge app store, real users at scale.
- Native desktop sync + mobile apps; document co-editing via Collabora / OnlyOffice.
- Established admin, backup, and enterprise tooling.

## Where Canopy differs

- **Footprint** — Canopy is a single Cloudflare Worker (or one Node process) and a far smaller
  codebase: no PHP, no server to patch, scale-to-zero on the edge.
- **Storage** — bring-your-own bytes (R2 / filesystem, or index a bucket in place) vs Nextcloud's
  data directory + database.
- A **slim core** where first-party features (Calendar, Tasks, Document AI…) are plugins on the
  same contract a third party uses.
- Canopy is young; Nextcloud's ecosystem dwarfs it today.

## Pick Nextcloud if

You want a mature, full-featured self-hosted platform and you're happy running and maintaining a
server.

[← Back to the comparison overview](how-it-compares)
