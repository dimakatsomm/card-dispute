# syntax=docker/dockerfile:1
# Build context is the repo root (pnpm catalog + lockfile live there):
#   docker build --platform linux/arm64 -f backend/lambdas/retention-sweeper/Dockerfile -t cd-retention-sweeper .

# The bundle is plain JS, so it builds on the native platform; only the runtime stage is ARM64 in CI and AWS.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch
COPY backend/packages/ backend/packages/
COPY backend/lambdas/retention-sweeper/package.json backend/lambdas/retention-sweeper/
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @cd/retention-sweeper...
COPY backend/lambdas/retention-sweeper/src backend/lambdas/retention-sweeper/src
RUN pnpm --filter @cd/retention-sweeper bundle

# Pinned from public.ecr.aws/lambda/nodejs:24 (multi-arch index digest; bump deliberately).
# Platform follows the build: CI and AWS pass --platform linux/arm64, a local compose build is native.
FROM public.ecr.aws/lambda/nodejs@sha256:92b7cccd985332238af80ac8da42d6965d418552e88955e315da4e3c0c76ca79
# The base image lags Amazon Linux fixes; our bundle carries its own AWS SDK, so the runtime copy and npm go.
RUN dnf upgrade -y --refresh --releasever=latest && dnf clean all && rm -rf /var/cache/dnf \
      /var/runtime/node_modules/@aws-sdk /var/lang/lib/node_modules/npm /var/lang/bin/npm /var/lang/bin/npx
# Node no longer trusts the RDS CA by default; the vendored bundle is verified at build (backend/packages/db/certs).
COPY --chmod=0444 backend/packages/db/certs/rds-global-bundle.pem /etc/ssl/rds/rds-global-bundle.pem
RUN echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /etc/ssl/rds/rds-global-bundle.pem" | sha256sum -c -
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds/rds-global-bundle.pem
COPY --from=build /repo/backend/lambdas/retention-sweeper/dist/index.mjs ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
