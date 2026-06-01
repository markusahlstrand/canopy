#!/bin/sh
# Start the Tailscale sidecar (if an auth key is provided), then run the service.
# With TS_AUTHKEY set, the Go proxy joins the tailnet and the service routes NAS
# fetches through it; without it, only inline parsing works (no tailnet egress).
set -e

if [ -n "$TS_AUTHKEY" ]; then
  echo "[docworker] starting tailnet proxy (ts-proxy)…"
  ts-proxy &
  export TAILNET_PROXY_URL="${TAILNET_PROXY_URL:-http://127.0.0.1:1055}"
else
  echo "[docworker] TS_AUTHKEY unset — tailnet egress disabled; inline parsing only."
  unset TAILNET_PROXY_URL
fi

exec pnpm --filter @canopy/docworker-service start
