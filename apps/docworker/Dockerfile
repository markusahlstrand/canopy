# Canopy document-parser container: the Node parsing service + a Tailscale (tsnet)
# sidecar for tailnet egress. linux/amd64 for Cloudflare Containers.
#
# BUILD CONTEXT MUST BE THE REPO ROOT (the service depends on @canopy/* workspace
# packages). In wrangler.jsonc set the container's build context to ".":
#   "containers": [{ "class_name": "DocWorker", "image": "./apps/docworker/Dockerfile",
#                    "image_build_context": "." }]
# or build locally with:  docker build -f apps/docworker/Dockerfile -t canopy-docworker .

# ── 1. Build the tsnet CONNECT proxy (static Go binary) ────────────────────────
FROM golang:1.26 AS proxy
WORKDIR /src
COPY apps/docworker/cmd/ts-proxy/go.mod apps/docworker/cmd/ts-proxy/go.sum ./
RUN go mod download
COPY apps/docworker/cmd/ts-proxy/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/ts-proxy .

# ── 2. The Node service (pnpm workspace install from the repo root) ─────────────
FROM node:22-slim AS app
RUN corepack enable
WORKDIR /repo
COPY . .
# Install only the service and its workspace dependencies (incl. dev deps for tsx).
RUN pnpm install --frozen-lockfile --filter @canopy/docworker-service...

# ── 3. Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY --from=app /repo /repo
COPY --from=proxy /out/ts-proxy /usr/local/bin/ts-proxy
COPY apps/docworker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
