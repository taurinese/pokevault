# syntax=docker/dockerfile:1
# PokéVault — multi-stage build (docs/03-architecture.md §5).
# Final targets: `web` and `worker` (consumed by .github/workflows/cd.yml and docker-compose.yml).

ARG NODE_IMAGE=node:24-slim

# ------------------------------------------------------------------- base --
FROM ${NODE_IMAGE} AS base
# pnpm version is pinned by the `packageManager` field in package.json.
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app

# ---------------------------------------------------------------- builder --
FROM base AS builder
# 1. Manifests only, so this layer stays cached until a manifest changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/domain/package.json packages/domain/package.json
COPY packages/services/package.json packages/services/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
# devDependencies (vite, rolldown, typescript) are required to build. NODE_ENV is
# scoped to this command only: a persistent NODE_ENV=development would leak into
# `vite build` and emit a dev JSX runtime (jsxDEV) that crashes under the
# production NODE_ENV of the final stage.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    NODE_ENV=development pnpm install --frozen-lockfile
# 2. TS configs + sources (after the install so editing them never busts the
#    dependency cache), then build every workspace package
#    (web dist/ + worker dist/index.mjs).
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
RUN pnpm build
# 3. Pruned production install of the web app (prod deps only, workspace
#    packages included). pnpm 10 requires --legacy here because the workspace
#    packages do not set inject-workspace-packages=true.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @pokevault/web deploy --prod --legacy /prod/web \
    && rm -rf /prod/web/src /prod/web/vite.config.ts /prod/web/tsconfig.json

# ------------------------------------------------------------------- web --
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
# Pruned prod install (package.json + node_modules with prod deps only).
COPY --from=builder --chown=node:node /prod/web/ /app/
# Build artifacts (dist/server/server.js + dist/client/*), copied explicitly so
# the runtime never depends on `pnpm deploy` internals.
COPY --from=builder --chown=node:node /app/apps/web/dist/ /app/dist/
USER node
EXPOSE 3000
# Zero-dependency healthcheck: node:24-slim ships fetch, no curl needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Same invocation as `pnpm start` in apps/web: `--static ../client` resolves
# relative to dist/server/, i.e. dist/client/.
CMD ["./node_modules/.bin/srvx", "--prod", "--static", "../client", "dist/server/server.js"]

# ---------------------------------------------------------------- worker --
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production
WORKDIR /app
# The worker bundle is self-contained (rolldown ESM, zero runtime deps).
COPY --from=builder --chown=node:node /app/apps/worker/dist/index.mjs /app/index.mjs
USER node
CMD ["node", "/app/index.mjs"]
