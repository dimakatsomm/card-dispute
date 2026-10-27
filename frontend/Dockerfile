# syntax=docker/dockerfile:1
# Build context is the repo root (pnpm catalog + lockfile live there):
#   docker build -f frontend/Dockerfile -t cd-web .

# The bundle is architecture-independent, so it builds on the native platform and only the runtime is ARM64.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch
COPY tsconfig.base.json ./
COPY frontend/ frontend/
# No dependency of the web build needs an install script; skipping them also narrows the supply-chain surface.
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @cd/web \
 && pnpm --filter @cd/web build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24 AS runtime
USER root
RUN apk upgrade --no-cache && rm -f /etc/nginx/conf.d/default.conf
COPY frontend/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0755 frontend/docker-entrypoint.sh /usr/local/bin/app-entrypoint.sh
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
