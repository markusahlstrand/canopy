# Sharing & spaces

Canopy shares files the way Drive and Dropbox do — you grant **people or groups** a
**role** on a file, or put files in a shared **space** everyone in it can access. There's no
"friends" concept; you share by email.

## Spaces

A **space** is a drive. Every user has a **personal** space (their "My Drive"), and can belong
to **group** spaces — a family, a book club, a team. Members of a group space co-access
everything in it. A file lives in exactly one space.

**Families feel merged, not separate.** A group space you belong to shows up as a **folder
inside your My Drive** (with a people glyph), next to your own folders and a "Shared with me"
entry — so you stay in your own drive rather than switching contexts. Under the hood it's still
a distinct space (its own membership, access, and dedup); it's only *surfaced* inline. You can
**unpin** a space (a per-person preference) to move it out of My Drive and reach it from the
sidebar switcher instead — handy for a big "company" space you don't want mixed in.

The same space is meant to surface in other apps too: a family space is a folder in the drive
*and* (planned) a shared calendar in the calendar app.

## Roles

Three roles, nested: **owner ⊇ editor ⊇ viewer**.

- **viewer** — read + download.
- **editor** — also upload, save new versions, edit metadata.
- **owner** — also share, manage, delete.

A role applies whether it's granted on a single file or on a whole space (space members get
their space role on every file in it).

## Sharing a file

Open a file → **Share**. Add someone **by email** with a role, or share with a whole **space**.

- If the person has signed in before, they get access immediately.
- If not, it's stored as a **pending invite** keyed by their email; the moment they first sign
  in, it resolves to a real grant and the file appears under their "Shared with me".

Server-side, every grant is a **relation tuple** — `file#role@subject`, where the subject is a
user, an email, or a space's members. Membership and per-file grants are the same primitive.

## Sharing a folder

Sharing isn't limited to a single file or a whole space — you can grant a role on one **virtual
folder** (and everything beneath it). It mirrors file sharing exactly: grant a person (by email)
or another space a role of **owner / editor / viewer**, with the same pending-invite resolution
— the same relation-tuple primitive, keyed by the space id plus the folder's virtual `path`.
Folders shared with you surface under **"Shared with me"** (`GET /api/shared-folders`).

## Inviting & managing members

Open a group space → **Members** and add anyone **by email**:

- If they already have an account, they join immediately.
- If they don't, it's a **pending invite**. Share the **copyable invite link** from the same
  dialog (over chat, SMS, however) — when they sign in with that email, the invite resolves and
  they become a member. Canopy never creates the account; they sign up with your identity
  provider themselves.

Assign each person a role, and remove members or pending invites anytime.

A login resolves any invites waiting on that email automatically. For an invite that arrives
*while* you're already signed in, Canopy surfaces an **invites banner** — *Accept* claims every
space pending for your address in one step, without a re-login. Accepting is gated on a verified
email, the same as login-time resolution.

This is **Canopy-native**: authentication stays with your OIDC provider (AuthHero/Auth0/…),
but membership and invites live in Canopy — so it works with any provider and isn't tied to a
vendor-specific "organizations" feature. Invites only resolve against a **verified** email, so
nobody can claim one by signing up with someone else's address.

## How access is decided

A check ("can this user open this file?") is evaluated with **relation tuples** in the spirit of
[Google Zanzibar](https://research.google/pubs/pub48190/) — but small: a single recursive SQL
query over one table. It resolves, taking the highest role found:

- a direct grant to the user (or a matching email invite),
- a grant to a space the user belongs to,
- the file's own space (members inherit their space role),
- nested groups (a group can be a member of another group).

Keeping the tuples in **one store** is deliberate: an authorization check is inherently
cross-cutting, so it stays a single query rather than fanning out across databases. Content
(files, blobs) can shard per space later; the authz graph stays centralized.

## Not yet

- **Link sharing** ("anyone with the link") — planned (a tokenized grant with an optional
  expiry).
