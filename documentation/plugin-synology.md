# Synology

A **storage connector** that browses a Synology DiskStation (DSM) as a space, over the
FileStation Web API — reachable directly, over **Tailscale**, or via QuickConnect.

## What it does

Point it at a NAS and a read-only **Synology** space appears in the sidebar. The connector role
runs trusted, server-side (it's the I/O boundary), backed by `@canopy/connector-synology`. It logs
in to DSM lazily for a session id, re-authenticating if the session expires, and discovers the
FileStation API paths so it works across DSM versions.

Unlike a pure live mount, the NAS tree is **indexed** into Canopy's `files`/`file_versions` tables
as `external` references (the bucket stays the source of truth — see
[Storage and files](storage-and-files)). The index is built and refreshed by a **background job**:
on Cloudflare a durable **Workflow** that crawls one folder per step (so a big NAS can't blow a
single request's budget and a crash resumes where it left off), and an in-process runner on Node.
It fires **when you connect** (saving your settings kicks a full index), from a **"Sync / Re-index"**
action in the connected space's sidebar menu, and from a periodic **sweep** — **incrementally** via
`SYNO.FileStation.Search` over `mtime` (a delete/rename bumps its folder, so the affected folders
are revisited), falling back to a bounded crawl. Browsing a folder also reconciles it lazily.

Because the indexed rows live in Canopy's DB, the NAS turns up in **search**, is reachable by
connected assistants over **MCP**, and is **mirrored to your browser like any other space** — so
once indexed it browses **offline and instantly** (the bytes still stream through the connector when
you open a file, or come from the per-space content cache). Out-of-band changes (e.g. a direct SMB
write) converge on the next sweep. `@eaDir` / `#recycle` are never indexed.

> The space is **read-only** to Canopy (only the reconciler writes its rows). Read-write
> (upload / new folder / delete straight onto the NAS) is the next milestone.

## Configuration

Install it first (**Settings → Connectors → Synology** — it's in the store, not installed by
default), then open the ⚙ on its card. Pick a **Connection** mode; the dialog shows only that
mode's fields.

| Field | Notes |
|---|---|
| Connection | `Direct address`, `Tailscale`, or `QuickConnect ID` (required) |
| Address | e.g. `https://nas.example.com:5001` — *direct* mode |
| Tailscale host | the NAS's MagicDNS name or `100.x` tailnet IP (e.g. `diskstation.tail1234.ts.net`) — *tailscale* mode. A bare host becomes `http://host:5000` (DSM's HTTP port; the tailnet already encrypts, so no self-signed-cert hassle) |
| Tailscale auth key | *tailscale* mode, **cloud/edge only** — lets the parser container join *your* tailnet (see below). Leave blank when self-hosting on a machine that's already on the tailnet |
| QuickConnect ID | resolved to a reachable address via Synology's coordinator |
| DSM account | a DSM user (required) |
| DSM password | stored as a secret (required) |
| One-time code | only if the account has 2-step verification on |
| Shared folder | e.g. `/home` or `/photos`; blank lists all shared folders at the root |

Secret fields (password, auth key) are encrypted **per-user** at rest and never returned to the
browser. For an unattended connection, prefer a **dedicated DSM user** over an account with
2-step verification (a one-time code can't be refreshed on its own).

## Reachability

The connector runs server-side, so what's reachable depends on **where Canopy runs**:

| Canopy runs… | How to reach the NAS |
|---|---|
| Self-hosted on the **LAN** | `Direct` — a LAN address (and a self-signed DSM cert) works |
| Self-hosted on a **tailnet** machine | `Tailscale` — the host is already a peer; no auth key needed |
| **Cloud / edge** (Workers) | `QuickConnect` / a public HTTPS address, **or** `Tailscale` through the [document-parser container](deploying) (needs the auth key) |

A Workers isolate can't be a tailnet peer, so on the edge a tailnet NAS is reached *through* the
optional [document-parser container](deploying), which joins your tailnet on demand.

QuickConnect resolution uses Synology's undocumented coordinator protocol: the ID is resolved
to an ordered list of candidate addresses (DDNS, WAN, relay tunnel, LAN) and the first that
responds is used and cached.

## Connecting over Tailscale

Tailscale keeps the NAS private (no public ports, no QuickConnect relay) while still reachable —
including from a Cloudflare deployment.

1. **Put the NAS on your tailnet.** Install the **Tailscale** package on the DiskStation (DSM →
   Package Center → Tailscale → sign in). It gets a MagicDNS name like
   `diskstation.<tailnet>.ts.net` and a `100.x` address. Running Tailscale on *another* box (e.g.
   Home Assistant) is **not** enough — in userspace mode it can't route to the NAS, so the NAS
   itself must be a node.
2. **Configure Canopy.** Connection = **Tailscale**, **Tailscale host** = that name (or the
   `100.x` IP), plus the DSM account/password.
3. **If Canopy runs on the edge,** also set a **Tailscale auth key** so the parser container can
   join your tailnet:
   - Admin console → Settings → Keys → **Generate auth key** → **Ephemeral** + **Reusable** (the
     container re-joins on each cold start; a single-use key fails the second time).
   - Add an **ACL** rule allowing that key's tag (or device) to reach the NAS on port `5000`.
   - Deploy *with* the container — `pnpm deploy:cf` (see [Deploying](deploying)).
   > Raw auth keys expire after **≤90 days**, so you'd re-mint periodically. A non-expiring
   > Tailscale **OAuth client** secret avoids the rotation; using one is planned — today the
   > field takes a raw key.

   Self-hosted on a tailnet machine? Leave the auth key blank — that host is already a peer.

## At a glance

- **Type:** App + storage connector
- **Contributes:** a detail view and a storage connector (a connected space)
- **Reaches:** a DSM box over FileStation — direct, over Tailscale, or via QuickConnect
- **Availability:** in the store, not installed by default
- **Category:** Media

## See also

- [Storage and files](storage-and-files) — connectors and the drive.
- [Synology comparison](compare-synology) — Canopy as the drive layer over a NAS.
- [Writing a plugin](writing-a-plugin) — building a connector.
