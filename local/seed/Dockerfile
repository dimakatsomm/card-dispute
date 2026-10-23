# syntax=docker/dockerfile:1
# dev-tools image (ADR-061). Build context is the repo root (pnpm catalog + lockfile live there):
#   docker build --platform linux/arm64 -f local/seed/Dockerfile -t cd-dev-tools .
# Run: command bootstrap | seed | probe [--expect-unreachable] [--hold <seconds>]; read-only root with /tmp writable, user 1000.

# Dependencies are pure JS, so they install on the native platform; only the runtime stage is ARM64.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch --prod
COPY backend/packages/ backend/packages/
COPY local/seed/package.json local/seed/
# Not `pnpm deploy` (ADR-052): it copies workspace packages into node_modules, where Node refuses to strip TS types.
RUN pnpm install --offline --prod --frozen-lockfile --ignore-scripts --filter @cd/seed...
COPY local/seed/src local/seed/src

FROM node:24.22.0-alpine3.24 AS runtime
ENV NODE_ENV=production
COPY --chmod=0444 backend/packages/db/certs/rds-global-bundle.pem /etc/ssl/rds/rds-global-bundle.pem
RUN echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /etc/ssl/rds/rds-global-bundle.pem" | sha256sum -c -
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds/rds-global-bundle.pem
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /repo/node_modules /app/node_modules
COPY --from=deps /repo/backend /app/backend
COPY --from=deps /repo/local /app/local
COPY --chmod=0755 <<'SCRIPT' /usr/local/bin/dev-tools
#!/bin/sh
set -eu
cmd="${1:-}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  bootstrap) exec node /app/backend/packages/db/bootstrap/main.ts "$@" ;;
  seed) exec node /app/local/seed/src/main.ts "$@" ;;
  probe) exec node /app/local/seed/src/probe-main.ts "$@" ;;
  *) echo "usage: dev-tools bootstrap | seed | probe [--expect-unreachable] [--hold <seconds>] [--help]" >&2; exit 64 ;;
esac
SCRIPT
# Nothing writes outside /tmp, so the task runs with readonlyRootFilesystem.
ENV HOME=/tmp
WORKDIR /app/local/seed
USER node
ENTRYPOINT ["/usr/local/bin/dev-tools"]
