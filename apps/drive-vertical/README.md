# @canopy/drive-vertical

Canopy's drive, packaged as a deployable Substrat vertical: **one Durable Object per
space**, the kernel's permission model, and no control plane of its own.

```
src/worker.ts      the deployable worker — ScopeDO, IdentityDO, SweeperDO, the auth seam
src/provision.ts   what `substrat push` reads: modules, roles, grant shapes
wrangler.jsonc     local `wrangler dev` only — the hosted deploy authors no wrangler config
```

The drive itself is [`@canopy/scope-drive`](../../packages/scope-drive). This app is the
deployment shell around it.

## Deploying to the platform

```sh
pnpm --filter @canopy/scope-drive build     # the vertical is bundled, so the package ships dist
pnpm --filter @canopy/drive-vertical check  # boundary-lint + the permission surface + its digest
substrat login                              # browser round-trip; the CLI session expires
pnpm --filter @canopy/drive-vertical push
```

`check` needs no credentials and is the one to run in CI. `push` uploads the worker,
registers the permission surface under the workspace tenant, and hands the platform the
`runtimeNeeds` from `package.json` — the bindings, the node-compat flag and the entry.
**No wrangler config is involved in that path**: anything in `wrangler.jsonc` is invisible
to a pushed install, by design.

## What an install gets, and what it does not

A fresh install **authenticates nobody**. There is no dev header and no fallback caller —
a header naming the caller is an impersonation bypass one environment variable from being
live, so the worker resolves a principal exactly one way: the configured OIDC issuer
verifies the request, and the tenant's `IdentityDO` maps that subject to a principal in
this scope. Until an install is given an issuer, every `/api/*` call is 401 and that is
the correct state.

The issuer arrives as one delivered value (`substrat:auth`, written by the dashboard's
Identity tab and read through `instanceAuthFor`), so one serving script runs many issuers
and a tenant's choice is a tenant's. `AUTH_PROVIDER=oidc` + `OIDC_ISSUER` is the
standalone fallback. Point it at authhero, or anything else that speaks OIDC — that is
configuration, not code.

The browser session is established at `/api/auth/login|callback|logout`, which the
provider itself serves; this vertical runs no credential store and hosts no sign-up.

At provision the platform names an owner: the worker records it in `IdentityDO` (so the
first sign-in claims the seat), adds the scope to this deployment's sweep roster, and
assigns the `owner` role — which holds all three drive keys scope-wide, because the owner
of a space may write anywhere in their own space. A `member` reads; write below the root
is a grant on a folder. If the owner never signs in, the platform can mint a claim link
once the first-sign-in window closes.

## Local

```sh
pnpm --filter @canopy/drive-vertical dev    # wrangler dev with ALLOW_DEV_NODE=true
```

`ALLOW_DEV_NODE` addresses an instance when no router asserted one. It is an **address,
not an identity** — it says which space an un-routed request belongs to and grants nobody
anything.

## Not yet wired

Bytes (the blob seam — operations record where bytes are, nothing moves them yet),
search, the changes feed, WebDAV, and any migration of existing canopy spaces. See
[`documentation/planning/scope-model-mapping.md`](../../documentation/planning/scope-model-mapping.md) §3.
