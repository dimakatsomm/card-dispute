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
FROM public.ecr.aws/lambda/nodejs@sha256:66c547b04b1ec3b0b832816df70d4911d0721b4d29717dd0bd5358876586092e
# Node no longer trusts the RDS CA by default; the vendored bundle is verified at build (backend/packages/db/certs).
COPY --chmod=0444 backend/packages/db/certs/rds-global-bundle.pem /etc/ssl/rds/rds-global-bundle.pem
RUN echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /etc/ssl/rds/rds-global-bundle.pem" | sha256sum -c -
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds/rds-global-bundle.pem
COPY --from=build /repo/backend/lambdas/retention-sweeper/dist/index.mjs ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
