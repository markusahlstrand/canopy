# Synology

A **storage connector** that browses a Synology DiskStation (DSM) as a space, over the
FileStation Web API — reachable directly or via QuickConnect.

## What it does

Point it at a NAS and a read-only **Synology** space appears in the sidebar, listing files
live from the box. The connector role runs trusted, server-side (it's the I/O boundary),
backed by `@canopy/connector-synology`. It logs in to DSM lazily for a session id,
re-authenticating if the session expires, and discovers the FileStation API paths so it
works across DSM versions. Files stream straight from the NAS — there are no drive rows —
the same passthrough model as a [connected GitHub repo](plugin-github).

> Read-write (upload / new folder / delete straight onto the NAS) is the next milestone;
> today the connected space is read-only.

## Configuration

| Field | Notes |
|---|---|
| Connection | `Direct address` or `QuickConnect ID` (required) |
| Address | e.g. `https://nas.example.com:5001` — for the direct mode |
| QuickConnect ID | resolved to a reachable address via Synology's coordinator |
| DSM account | a DSM user (required) |
| DSM password | stored as a secret (required) |
| One-time code | only if the account has 2-step verification on |
| Shared folder | e.g. `/home` or `/photos`; blank lists all shared folders at the root |

For an unattended connection, prefer a **dedicated DSM user** over an account with 2-step
verification (a one-time code can't be refreshed on its own).

## Reachability

- **Self-hosted on the LAN:** a direct LAN address (and a self-signed DSM cert) works.
- **From a cloud deployment (Workers):** a LAN address or self-signed cert is **not**
  reachable — use QuickConnect (its relay tunnel) or a public HTTPS / DDNS address.

QuickConnect resolution uses Synology's undocumented coordinator protocol: the ID is
resolved to an ordered list of candidate addresses (DDNS, WAN, relay tunnel, LAN) and the
first that responds is used and cached.

## At a glance

- **Type:** App + storage connector
- **Contributes:** a detail view and a storage connector (a connected space)
- **Reaches:** a DSM box over FileStation, direct or via QuickConnect
- **Availability:** in the store, not installed by default
- **Category:** Media

## See also

- [Storage and files](storage-and-files) — connectors and the drive.
- [Synology comparison](compare-synology) — Canopy as the drive layer over a NAS.
- [Writing a plugin](writing-a-plugin) — building a connector.
