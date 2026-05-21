# syntax=docker/dockerfile:1

# Canopy as a single Node process: the API serves the built SPA + /api on one port.
# (Cloudflare uses the Worker instead — see apps/api/wrangler.jsonc.)

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
WORKDIR /app

# ---- build: install deps and build the SPA ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @canopy/portal build

# ---- runtime: serve UI + API from apps/api ----
FROM base AS runtime
ENV NODE_ENV=production
# The drive's storage root — mount a volume here.
ENV CANOPY_LOCAL_ROOT=/data
COPY --from=build /app /app
RUN mkdir -p /data

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# api `start` runs `tsx src/node.ts` with cwd=apps/api, which serves ../portal/dist + /api.
CMD ["pnpm", "--filter", "@canopy/api", "start"]
