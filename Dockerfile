# syntax=docker/dockerfile:1

# One image serves the API and the built web app on one port (D34).
#   docker build -t 16bit .
#   docker compose up            # Postgres, migrations, then the app on http://localhost:8080
# The API runs its TypeScript directly on Node (type stripping), so only the web app is built.

ARG NODE_IMAGE=node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

FROM ${NODE_IMAGE} AS pnpm
# Same version as `packageManager` in package.json. Installed with npm, not corepack:
# pnpm 12 no longer ships the bin/pnpm.cjs that corepack launches.
RUN npm install --global pnpm@12.21.0 && npm cache clean --force
WORKDIR /app
# Only the manifests, so the install layers stay cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json e2e/package.json ./

FROM pnpm AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter '@16bit/web...'
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @16bit/web build

FROM pnpm AS api
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store --filter '@16bit/api...'
COPY packages/core packages/core
COPY apps/api apps/api

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_ROOT=/app/apps/web/dist
WORKDIR /app
# Workspace layout kept as is: node only strips types outside node_modules, and the
# @16bit/core symlink resolves to packages/core.
COPY --from=api /app ./
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "src/server.ts"]
