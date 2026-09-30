# Canopy

Canopy is a drive running as a [Substrat](https://github.com/substrat-run/substrat) vertical. The current product is a React app and same-origin API in <code>apps/drive-vertical</code>, backed by the scope-local <code>@canopy/scope-drive</code> module. One space is one Substrat scope.

The drive supports folder navigation, uploads and downloads, rename and move, Trash and restore, version history reads, file preview, search by name and extracted PDF text, invitations, and folder sharing. OIDC supplies sign-in; the kernel checks roles and grants.

## Repository layout

| Path | Purpose |
|---|---|
| <code>apps/drive-vertical</code> | The deployed worker, SPA, identity and attachment routes |
| <code>packages/scope-drive</code> | Drive model, scope-local operations, permissions, migrations, and tests |
| <code>packages/ui</code> | Shared UI primitives |
| <code>apps/api</code>, <code>packages/store</code> | Legacy shared-database API and store, retained during migration |
| <code>packages/connectors/*</code>, <code>packages/mirror</code> | Existing implementations to adapt as later migration work |

The retired <code>apps/portal</code> no longer serves the drive. The old API still contains connectors, WebDAV, MCP, and other services; deploying it does not deploy the current drive UI or import its data into a scope.

## Develop

Requires Node 22 and pnpm.

~~~sh
pnpm install
pnpm dev
~~~

That runs the vertical's worker with Wrangler. For front-end HMR, also run <code>pnpm dev:web</code> and open Vite on port 5769; it proxies <code>/api</code> to the worker on port 8787. Local scope addressing grants no identity, so configure an OIDC issuer to sign in. <code>pnpm dev:api</code> runs the separate legacy API when needed.

## Check and deploy

~~~sh
pnpm --filter @canopy/scope-drive build
pnpm --filter @canopy/drive-vertical check
substrat login
pnpm push
~~~

<code>pnpm push</code> deploys the vertical through Substrat. Its runtime needs are declared in <code>apps/drive-vertical/package.json</code>; the vertical's <code>wrangler.jsonc</code> is for local development. An install needs an OIDC issuer configured before anyone can sign in.

The root <code>pnpm deploy</code> deploys the legacy API Worker. It is separate from <code>pnpm push</code> and does not serve the vertical UI.

## Migration status

The vertical's uploaded bytes use the platform attachment surface and per-tenant blob stores. PDF extraction currently runs after upload, so older files and missed attempts need [durable backfill](https://github.com/markusahlstrand/canopy/issues/66). Connected storage, semantic search, offline mirroring, WebDAV on the vertical, and migration of legacy spaces remain open. The retired portal's plugin runtime has no vertical replacement yet; see [#73](https://github.com/markusahlstrand/canopy/issues/73).

For more detail, read the [overview](documentation/01-overview.md), [architecture](documentation/02-architecture.md), [storage model](documentation/07-storage-and-files.md), and [deployment guide](documentation/06-deploying.md). The [convergence rail](documentation/planning/substrat-extraction-tickets.md) records the larger plan, though its September snapshot predates the newest vertical work.

## License

MIT
