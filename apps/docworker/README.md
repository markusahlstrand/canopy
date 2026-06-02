# @canopy/docworker-service

The document-parsing **container** for Canopy: an HTTP service that wraps the
in-process parser ([`@canopy/docworker`](../../packages/docworker)) and adds the
one thing a Cloudflare Worker can't do — read a **tailnet-only Synology source**
itself, via an embedded Tailscale (`tsnet`) sidecar.

It's an *adapter backend*, not a requirement. Canopy runs fully on pure Node with
the in-process parser; this service exists to (a) offload heavy PDF/spreadsheet
parsing off the Workers isolate, and (b) reach a NAS on your tailnet from the
Cloudflare edge.

## Endpoints

All POST; protected by an `X-Docworker-Token` shared secret (except `/health`).

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | `{ ok: true }` |
| `/extract?offset=&limit=` | raw bytes (`X-Doc-Name`, `X-Doc-Mime` headers) | `RangedText` (`{ text, total, truncated, pageCount }`) |
| `/extract/tables` | raw bytes | `DocTables` |
| `/extract/outline` | raw bytes | `DocOutline` |
| `/synology/extract` | JSON `{ source:{config,path}, format, offset?, limit? }` | reads NAS bytes over the tailnet, then parses |
| `/synology/{list,stat,read,remove,mkdir}` | JSON `{ config, path, cursor?, limit? }` | the full `StorageConnector` surface, proxied over the tailnet (the edge's connected-space path) |
| `/synology/write` | raw bytes + `X-Syn-Path`/`X-Syn-Config` headers | `StorageEntry` |

All `/synology/*` routes carry `X-TS-AuthKey` (the per-user tailnet key) so the DO can start the instance on the right tailnet; they `ensureTailnetReady()` first so a cold start doesn't race the handshake.

## Run locally (pure Node)

No container, no Cloudflare. If the host machine is on your tailnet, the
`/synology/extract` route works directly (no proxy needed).

```sh
pnpm --filter @canopy/docworker-service dev      # listens on :8080
curl localhost:8080/health
curl -X POST localhost:8080/extract/tables -H 'x-doc-name: b.csv' --data-binary $'a,b\n1,2\n'
```

Env: `PORT` (8080), `DOCWORKER_TOKEN` (optional shared secret), `TAILNET_PROXY_URL`
(set only when routing through the Go proxy instead of the host's Tailscale).

## The tailnet sidecar (`cmd/ts-proxy`)

A tiny Go binary using `tailscale.com/tsnet` (userspace — no TUN, no `NET_ADMIN`).
It joins your tailnet and exposes a local HTTP CONNECT proxy on `127.0.0.1:1055`;
the service routes NAS fetches through it (`TAILNET_PROXY_URL`). On Cloudflare
Containers, where outbound UDP isn't available, Tailscale falls back to
DERP-relay over HTTPS/443.

## Deploy as a Cloudflare Container

Wired in the root `wrangler.jsonc` (`containers` + the `DocWorker` Durable Object).
The Worker only uses it when `DOCWORKER` + `DOCWORKER_TOKEN` are present; otherwise
it parses in-process. Needs Docker locally to build the `linux/amd64` image.

```sh
# 1. Secret — only the tailnet key is required (the DO binding is the auth boundary;
#    a container has no public ingress, so no shared secret is needed for the hop).
wrangler secret put TS_AUTHKEY          # ephemeral, TAGGED Tailscale auth key
# Optional defense-in-depth on the Worker→container hop:
# wrangler secret put DOCWORKER_TOKEN

# 2. Deploy (builds the image; context is the repo root)
pnpm deploy:cf
```

### Feasibility spike (do this first)

The unproven bit is whether Tailscale establishes from a Cloudflare Container
(it relies on DERP-over-443, since UDP isn't documented there). Before depending
on it, deploy and check from the container:

```sh
tailscale netcheck      # expect a working DERP relay, not necessarily "direct"
tailscale status        # the node should appear and reach your NAS's tailnet IP
```

If it doesn't connect, the fallback is **Cloudflare Tunnel from a tailnet box**
(e.g. `cloudflared` on the Home Assistant host already on your tailnet) — point
the Worker at that and keep this container a pure parser.

## Per-tenant tailnet

Tailnet auth is **per user**, not a deploy-wide secret: each user's Tailscale auth
key + host live in their encrypted `plugin_settings` (Synology connector config).
The Worker decrypts them per request and routes to a **per-user container
instance** — `getContainer(env.DOCWORKER, "ts-" + hash(authKey))` — so each
tailnet identity gets an isolated instance and user A's parser can never reach
user B's tailnet. The DO reads `X-TS-AuthKey` and starts *its* container's tsnet
sidecar on that tailnet. The global `TS_AUTHKEY` Worker secret is only an optional
single-tenant fallback.

## Architecture

```text
Worker (isolate)                         Container instance per tailnet identity
  DocWorker adapter ───HTTP via DO───▶   /extract*  ─▶ @canopy/docworker (unpdf + SheetJS)
  edge Synology connector ──per-user──▶  /synology/* ─▶ connector ──tsnet (user's key)──▶ NAS
Node (local)
  inProcessDocWorker ─▶ @canopy/docworker           (reaches the NAS directly if on the tailnet)
```
