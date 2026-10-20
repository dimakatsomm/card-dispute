# syntax=docker/dockerfile:1
# Build context is the repo root (pnpm catalog + lockfile live there):
#   docker build --platform linux/arm64 -f backend/lambdas/dispute-notifier/Dockerfile -t cd-dispute-notifier .

# The bundle is plain JS, so it builds on the native platform; only the runtime stage is ARM64.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch
COPY backend/packages/ backend/packages/
COPY backend/lambdas/dispute-notifier/package.json backend/lambdas/dispute-notifier/
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @cd/dispute-notifier...
COPY backend/lambdas/dispute-notifier/build.ts backend/lambdas/dispute-notifier/
COPY backend/lambdas/dispute-notifier/src backend/lambdas/dispute-notifier/src
RUN pnpm --filter @cd/dispute-notifier build

FROM public.ecr.aws/lambda/nodejs:24
COPY --from=build /repo/backend/lambdas/dispute-notifier/dist/ ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
