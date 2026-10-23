# syntax=docker/dockerfile:1
# Build context is the repo root (pnpm catalog + lockfile live there):
#   docker build --platform linux/arm64 --provenance=false -f backend/lambdas/evidence-intake/Dockerfile -t cd-evidence-intake .

# The bundle is plain JS, so it builds on the native platform; only the runtime stage is ARM64 in CI and AWS.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch
COPY backend/packages/ backend/packages/
COPY backend/lambdas/evidence-intake/package.json backend/lambdas/evidence-intake/
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @cd/evidence-intake...
COPY backend/lambdas/evidence-intake/bundle.ts backend/lambdas/evidence-intake/
COPY backend/lambdas/evidence-intake/src backend/lambdas/evidence-intake/src
RUN pnpm --filter @cd/evidence-intake bundle

# Pinned from public.ecr.aws/lambda/nodejs:24 (multi-arch index digest; bump deliberately).
# Platform follows the build: CI and AWS pass --platform linux/arm64, a local compose build is native.
FROM public.ecr.aws/lambda/nodejs@sha256:92b7cccd985332238af80ac8da42d6965d418552e88955e315da4e3c0c76ca79
# The base image lags Amazon Linux fixes; our bundle carries its own AWS SDK, so the runtime copy and npm go.
RUN dnf upgrade -y --refresh --releasever=latest && dnf clean all && rm -rf /var/cache/dnf \
      /var/runtime/node_modules/@aws-sdk /var/lang/lib/node_modules/npm /var/lang/bin/npm /var/lang/bin/npx
COPY --from=build --chmod=0444 /repo/backend/lambdas/evidence-intake/dist/index.mjs ${LAMBDA_TASK_ROOT}/
# AWS runs functions as its own unprivileged user; this keeps the local RIE container off root too.
USER 65534:65534
CMD ["index.handler"]
