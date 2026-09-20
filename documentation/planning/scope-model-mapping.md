# Canopy onto the scope model

*S1 of the convergence rail ([#42](https://github.com/markusahlstrand/canopy/issues/42)),
written against `@substrat-run/*` 0.114.0 and proved by `packages/scope-drive`.*

The July rail asked for this document to be written first, against the kernel design.
It is written differently: against a **running module**. `packages/scope-drive` models the
drive's core triple — folder → file → file_version — as a Substrat module, runs it on
`adapter-sqlite`, and passes seven assertions about the move. Everything below is what
that cost, and it is a more honest mapping than a reading of the design docs would have
produced, because four of the six findings only appear when the code runs.

## 1. The mapping

| Canopy | Substrat | Note |
|---|---|---|
| user | tenant (personal tenant) | unchanged from the July reading |
| **space** | **scope**, `kind: 'space'`, Shape A | the crux: the space id stops being a column and becomes the database |
| space residency | scope `jurisdiction` | `'eu'` is the intent. The type is now `'eu' \| 'us' \| 'global'`, non-null, defaulting to `global`, and `eu`/`us` are **refused at the provisioning boundary today** — accepting one would record a residency guarantee with no mechanism behind it. So a scope provisions as `global` until that gate opens, and the drive must not claim otherwise in a UI |
| portal + plugins | vertical | |
| `spaces.kind = 'personal' \| 'group'` | scope `kind`, tenant shape | a group space is a scope with more than one member, not a different type |
| `files` + `folders` + `file_versions` | module-owned tables inside the scope | no `tenant_id` anywhere; the assertion is in the suite |
| `files.metadata.path` (JSON) | `drive_folders.path` column + a parent edge | canopy addressed files *by path*, so a rename rewrote every descendant |
| `folder_grants` + `pathRole()` walk | kernel grants on a folder entity + declared parent edges | the walk is the kernel's, and it returns a proof |
| `authz.ts` call sites | `ctx.check(...)` + `assertAllowed` | one per operation, same places |
| space membership | a role holding `drive:read` | membership *is* the grant for reading a shared space |
| `space_seq` + `/api/changes` | the event spine (S8) | not converted here |
| `blobs` (content-addressed, ref-counted) | a blob ref on the version row | the bytes seam stays outside `invoke` |

## 2. What the running code taught

These are the findings that matter, in the order they bit.

**A declared parent edge is permission-relevant only once something links it.**
`parents: ['folder']` in the model says the edge *may* exist. `ctx.link(child, parent)` in
the handler is what makes a folder's actual parent a fact the checker walks. Skip it and a
grant on the root reaches exactly nothing beneath it — which is a sharper version of
canopy's own rule, where `pathRole` recomputed the ancestor chain from a path string on
every read. The chain is now written once, at creation, and read by the kernel.

**The declaration names the permission; the handler still asks.**
`permission: { key, entity, idFrom }` on an operation feeds the registry, the routes and
the generated document. It does not gate `invoke`. The handler calls `ctx.check` and
`assertAllowed` itself — so canopy's `authz.ts` call sites convert one-for-one into check
call sites, and there is no "the framework will handle it" step to get wrong.

**A read declares its filter vocabulary, or it cannot filter (K-41).**
`drive/list-folder` filtering by `folder_id` requires `filterable: ['folder_id']` in the
`paged.over` declaration; the kernel composes the `WHERE`, the keyset comparison and the
index from it. Canopy's list endpoints compose their own SQL and take whatever filter the
caller sends, so every one of them needs its vocabulary written down as it converts.

**A role must hold at least one permission**, which forced the membership question early
and usefully: is reading a space's drive a *role* or a *grant*? Canopy's answer is already
the role — a family space is shared by being a space. So `drive:read` is scope-wide for
members, and `drive:write` / `drive:manage` are grants on a folder. That split is the
whole of canopy's viewer/editor/owner ladder, expressed in the kernel's terms.

**Bytes never ride `invoke`.** Substrat learned it on the attachment surface, canopy
learned it in the blob store, and the conversion inherits it: `drive/put-file` records a
version and names where the bytes are. Putting them there is a separate seam, and the
documents service (S9) is where it lands.

**`ctx.now()` returns a branded instant, `substratError` has a closed code list**, and
`z` comes from `@substrat-run/contracts`. Small, but they are the difference between a
module that compiles and one that nearly does.

## 3. What is proved, and what is not

`packages/scope-drive` asserts:

- the scope-local schema carries no space id — the conversion, in one assertion
- a folder is created, a file written into it, and the listing is one hop then a local query
- writing the same name again supersedes: one file, two versions, newest first
- a member reads the space drive (membership is the grant), and is refused the write nobody granted
- another tenant's scope shares no rows, not even at the same path

It does **not** prove: shares to outsiders, connector-backed spaces, WebDAV, the bytes
seam, search, the changes feed, or anything about migrating existing data. Those are the
rest of S9/S10, and the order in the rail still holds — reads, then metadata writes, then
blob writes, then WebDAV.

## 4. Where the two halves of this ticket live

S1's acceptance asks for the mapping to be merged platform-side with its open questions
filed against the kernel-design list. It lands as two halves, because it has to:

- **The open questions are filed platform-side** and are in flight there — cross-scope
  reads and the absent subscribe surface, a tuple whose subject is another scope, and the
  blob-key dedup trade (`scope/<scopeId>/<attachmentId>` is write-once by construction,
  right for entity-attached files, a storage bill for a documents product). The
  jurisdiction correction above rides the same change.
- **This document stays here**, and that is deliberate rather than a shortcut. The
  platform repo is public and its own conventions say to write the *shape* and never the
  identity of a product built on it. A mapping table whose left column is canopy's schema
  cannot go there without breaking that rule, and the part that is genuinely
  platform-shaped — the gaps — is the part already filed.

## 5. The mismatches that remain open

- **A cross-space read has no home.** Canopy's drive lists *every* space a person can see,
  merged. Inside the scope model that is N hops, and the platform's own open question (a
  principal in N scopes has no read path for the screen that lists them, and no subscribe
  surface) says there is no answer yet. This is the single biggest shape mismatch left,
  and it is the portal's home screen.
- **Folder moves.** A move re-parents a subtree; the permission model's audit property
  rests on grants not silently changing meaning. Canopy wants grants to follow the move.
- **Shares to non-members** (link shares, `shares.secret_hash`) have no counterpart yet: a
  share is a capability held by nobody, which is not a principal the checker knows.
- **The personal/group split.** Canopy shows a group space inline in My Drive when it is
  "mounted" — a per-user presentation fact about another scope, which nothing in the scope
  model holds today.

## 6. Next

Per the rail: S2 ([#43](https://github.com/markusahlstrand/canopy/issues/43)) before any
further jobs work, then the read path widens (search, then the bytes seam) rather than
deepens. The module here is the place each of those lands.
