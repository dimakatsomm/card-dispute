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
FROM public.ecr.aws/lambda/nodejs@sha256:66c547b04b1ec3b0b832816df70d4911d0721b4d29717dd0bd5358876586092e
COPY --from=build --chmod=0444 /repo/backend/lambdas/evidence-intake/dist/index.mjs ${LAMBDA_TASK_ROOT}/
# AWS runs functions as its own unprivileged user; this keeps the local RIE container off root too.
USER 65534:65534
CMD ["index.handler"]
