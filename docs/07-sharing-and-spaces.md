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

## Managing a space's members

Open a group space → **Members**. Add people by email (they must have signed in once — space
membership is by account, unlike per-file email invites) and assign each a role; remove anyone
who shouldn't be there.

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
- **Folder-level sharing** — today you share a file or a whole space; sharing an individual
  virtual folder comes later.
