# syntax=docker/dockerfile:1
# Cumulus orchestrator image. Build context: repository root.
#   docker build -f packages/orchestrator/Dockerfile .
# renovate: datasource=docker depName=node versioning=node
ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /app
RUN corepack enable pnpm
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @cumulus/ui build \
 && pnpm --filter "@cumulus/orchestrator..." build \
 && find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --offline

FROM node:${NODE_VERSION}-bookworm-slim
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/orchestrator/package.json ./packages/orchestrator/package.json
COPY --from=build /app/packages/orchestrator/node_modules ./packages/orchestrator/node_modules
COPY --from=build /app/packages/orchestrator/dist ./packages/orchestrator/dist
COPY --from=build /app/packages/orchestrator/public ./packages/orchestrator/public
COPY --from=build /app/packages/orchestrator/drizzle ./packages/orchestrator/drizzle
# The `node` user of the base image; numeric so Kubernetes runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080 8081
ENTRYPOINT ["/usr/bin/tini", "--", "node", "packages/orchestrator/dist/cli.js"]
