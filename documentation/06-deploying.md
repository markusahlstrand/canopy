# Deploying

The current drive ships as a Substrat vertical. Its worker serves its own React SPA and same-origin <code>/api/*</code> routes. Substrat provisions the scope and identity Durable Objects and binds a per-tenant blob store. The root <code>wrangler.jsonc</code> and <code>pnpm deploy</code> still deploy the legacy API; they do not deploy the drive UI.

## Local development

Use Node 22 and pnpm:

~~~sh
pnpm install
pnpm dev
~~~

<code>pnpm dev</code> runs the drive vertical with Wrangler. Its <code>ALLOW_DEV_NODE</code> setting supplies a local scope address, not a caller identity. A usable signed-in drive still needs an OIDC issuer. For front-end HMR, run <code>pnpm dev:web</code>; Vite proxies API requests to the vertical. The legacy API can be run separately with <code>pnpm dev:api</code> when working on its remaining services.

## Check and push the vertical

~~~sh
pnpm --filter @canopy/scope-drive build
pnpm --filter @canopy/drive-vertical check
substrat login
pnpm push
~~~

<code>check</code> validates the bundle and the Substrat permission surface without deploying. <code>pnpm push</code> deploys the vertical to the platform. The push reads <code>apps/drive-vertical/package.json</code>: its entry, assets, Durable Object classes, and blob-store need. The hosted path does not read the vertical's <code>wrangler.jsonc</code>; that file is for local Wrangler development.

A fresh install has no working login until its OIDC issuer is configured. The install's Identity settings deliver that configuration; the worker uses it to establish its same-origin session. The platform's owner claim and Canopy's invitation flow bind signed-in subjects to principals in a space. See [the vertical README](../apps/drive-vertical/README.md) for the current auth and byte boundaries.

## Legacy deployment

The root <code>pnpm deploy</code> and Docker/Node entry points serve <code>apps/api</code>, which still carries the old shared-database store, connectors, MCP, and document-worker paths. They are separate from the Substrat-hosted drive. Treat their deployment instructions as legacy service instructions; they do not create or populate a Substrat space.

Existing legacy data is not imported by <code>substrat push</code>. That migration remains part of [S10](https://github.com/markusahlstrand/canopy/issues/49).
