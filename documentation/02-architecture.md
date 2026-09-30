# Architecture

## Running shape

Canopy's drive is a Substrat vertical. The browser app and Hono worker are in <code>apps/drive-vertical</code>; the domain module is <code>packages/scope-drive</code>. One install can serve several spaces. Each space is a separate Substrat scope, hosted by its own <code>ScopeDO</code>, with no space ID column in the drive tables.

~~~text
Browser SPA
  → same-origin /api route in drive-vertical
  → resolve the signed-in principal and selected space
  → kernel ScopeStub.invoke(...)
  → scope-local drive operation and permission check
  → scope-local SQLite rows and kernel event spine
~~~

The router asserts the tenant and home scope. The app can select another space in that tenant by site slug or scope ID; that address grants no access. The kernel checks the caller's permission inside the selected scope. <code>IdentityDO</code> resolves the issuer's subject to a principal and keeps the space registry. <code>SweeperDO</code> keeps a roster of provisioned scopes for recurring work.

## Packages

| Path | Role |
|---|---|
| <code>packages/scope-drive</code> | File tree, versions, sharing, search operations, model, and scope-local migrations |
| <code>apps/drive-vertical</code> | Hosted worker, OIDC flow, attachment routes, people routes, and React drive |
| <code>packages/ui</code> | UI primitives used by the drive |
| <code>packages/store</code>, <code>apps/api</code> | Earlier shared-database implementation and remaining legacy services |
| <code>packages/mirror</code>, <code>packages/connectors/*</code> | Existing mechanisms to reconcile or port later |

The old shared database placed many spaces in one store and filtered on a space ID. The vertical uses the scope as the isolation boundary. A migration of existing data is still outstanding; deploying the vertical does not copy legacy spaces into it.

## Reads, writes, and bytes

A folder listing invokes <code>drive/list-folder</code> and pages scope-local rows. Operations such as rename, move, trash, and sharing call <code>ctx.check</code> inside the module, using the kernel's parent edges and grants. The declaration of a permission is not itself an authorization check.

An upload creates or finds the file row, writes bytes through the attachment surface, then records a version naming the attachment. Bytes never pass through <code>invoke</code>. A download resolves the current version through an operation and opens its attachment through the host's permission-gated attachment surface. The browser and API are served from the same origin.

A PDF upload can extract text after the response and invoke <code>drive/record-text</code>. The module stores the result beside the file and the kernel indexes declared fields. Search returns name and content hits through the kernel checker. There is no durable text backfill yet, so an older file may have no extraction record.

## Identity and permissions

The install receives its OIDC configuration from Substrat. Without an issuer, no person authenticates. The issuer verifies a subject; the tenant's identity directory maps that subject to a principal in the selected scope. Owners and members hold kernel roles; folder grants narrow write and manage access. Invite, roster, and removal flows are served by the vertical.

## Current boundaries

The vertical has no plugin runtime, connected-source byte reader, offline mirror, or WebDAV route. The old API still contains versions of some of those mechanisms, but the current drive UI does not call them. See [the migration plan](planning/substrat-extraction-tickets.md) for the remaining work and [the scope mapping](planning/scope-model-mapping.md) for the original shared-database mismatch.
