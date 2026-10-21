# syntax=docker/dockerfile:1
# Build context is the repo root (pnpm catalog + lockfile live there):
#   docker build --platform linux/arm64 -f backend/auth/Dockerfile -t cd-auth .
# Run: default CMD serves 8080 (health only) + 8081 (/validate). Migration task: command ["migrate"] with MIGRATOR_DATABASE_URL (auth_migrator).

# Dependencies are pure JS, so they install on the native platform; only the runtime stage is ARM64.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch --prod
COPY backend/packages/ backend/packages/
COPY backend/auth/package.json backend/auth/
# Not `pnpm deploy` (ADR-052): it copies workspace packages into node_modules, where Node refuses to strip TS types.
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter @cd/auth...
COPY backend/auth/src backend/auth/src
COPY backend/auth/migrations/*.sql backend/auth/migrations/

FROM node:24.22.0-alpine3.24 AS runtime
ENV NODE_ENV=production
COPY --chmod=0444 backend/packages/db/certs/rds-global-bundle.pem /etc/ssl/rds/rds-global-bundle.pem
RUN echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /etc/ssl/rds/rds-global-bundle.pem" | sha256sum -c -
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds/rds-global-bundle.pem
# The runtime never installs packages; dropping the bundled package managers removes their CVEs from the scan.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /repo/node_modules /app/node_modules
COPY --from=deps /repo/backend /app/backend
COPY --chmod=0755 <<'EOF' /usr/local/bin/migrate
#!/bin/sh
exec node /app/backend/auth/src/main.ts migrate "$@"
EOF
WORKDIR /app/backend/auth
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/main.ts", "serve"]
