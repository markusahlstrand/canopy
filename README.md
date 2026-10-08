# Canopy

Canopy is a drive running as a [Substrat](https://github.com/substrat-run/substrat) vertical. The current product is a React app and same-origin API in <code>apps/drive-vertical</code>, backed by the scope-local <code>@canopy/scope-drive</code> module. One space is one Substrat scope.

The drive supports folder navigation, uploads and downloads, rename and move, Trash and restore, version history, file preview and text editing, search by name, extracted content and metadata, invitations, and folder sharing. Plugins can be installed for a person or a space. OIDC supplies sign-in; the kernel checks roles and grants.

Folder sharing is the supported sharing unit in the current vertical. Individual-file sharing is outside the S12a UI closeout scope.

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

That starts the local OIDC issuer, provisions a local drive in the Wrangler worker on port 8787, and runs Vite with front-end HMR on http://localhost:5769. Sign in and choose **Local Owner** to claim the drive on first use. **Local Guest** can join through an invitation. Local data and uploads persist in Wrangler's ignored `.wrangler` directory between runs. Ctrl+C stops all three services.

<code>pnpm dev:worker</code> and <code>pnpm dev:web</code> start the worker and UI individually. <code>pnpm dev:api</code> runs the separate legacy API when needed.

## Browser acceptance

~~~sh
pnpm exec playwright install chromium
pnpm test:e2e
~~~

This builds the SPA and runs desktop and mobile Chromium against the real Wrangler worker, OIDC login, SQLite Durable Objects, and R2 attachments. Each run provisions an empty drive in a disposable directory and removes it when the server stops. It uses ports 8987 and 8989 and refuses to reuse another server. Your local development data and hosted drives are separate.

The drive suite checks navigation and empty states, folder and file rename/move, upload/download byte equality, Trash/restore, historical downloads, and collision/request-failure retries. A separate CI job runs it on every PR. Failure traces and screenshots are ignored by Git and retained as CI artifacts for seven days.

These checks establish browser behavior with the production bundle and real local services. Issue-specific hosted acceptance is recorded separately in `documentation/acceptance`.

## Check and deploy

~~~sh
pnpm --filter @canopy/scope-drive build
pnpm --filter @canopy/drive-vertical check
substrat login
pnpm push
~~~

<code>pnpm push</code> deploys the vertical's code through Substrat. Each installed drive has its own hostname: Substrat binds a default hostname when the app is created, and custom domains are managed in that app's Domains settings. See [hostnames](documentation/06-deploying.md#hostnames). Runtime needs are declared in <code>apps/drive-vertical/package.json</code>; the vertical's <code>wrangler.jsonc</code> is for local development. An install needs an OIDC issuer configured before anyone can sign in.

The root <code>pnpm deploy</code> deploys the legacy API Worker. It is separate from <code>pnpm push</code> and does not serve the vertical UI.

## Migration status

The vertical's uploaded bytes use the platform attachment surface and per-tenant blob stores. A durable text backfill revisits older and failed extractions. The browser saves file and folder names for offline browsing by default. A person can mark a folder to cache its readable files for read-only offline preview and download; offline writes still require a connection. The drive includes a bundled plugin catalog and can import a plugin from a ZIP, public GitHub repository, or npm package for review before installation. [Deployed UI acceptance](https://github.com/markusahlstrand/canopy/issues/78) is still in progress. Connected storage, semantic search, WebDAV on the vertical, and migration of legacy spaces remain open.

For more detail, read the [overview](documentation/01-overview.md), [architecture](documentation/02-architecture.md), [storage model](documentation/07-storage-and-files.md), and [deployment guide](documentation/06-deploying.md). The [convergence rail](documentation/planning/substrat-extraction-tickets.md) records the larger plan, though its September snapshot predates the newest vertical work.

## License

MIT
