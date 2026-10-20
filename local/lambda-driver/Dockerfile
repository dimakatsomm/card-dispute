# syntax=docker/dockerfile:1
# Local only, never deployed. Build context is the repo root; compose runs one container per mode.
FROM node:24.22.0-alpine3.24
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/packages/ backend/packages/
COPY local/lambda-driver/package.json local/lambda-driver/
# Not `pnpm deploy` (ADR-052): Node refuses to strip TS types under node_modules.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @cd/lambda-driver...
COPY local/lambda-driver/src local/lambda-driver/src
USER node
WORKDIR /repo/local/lambda-driver
ENTRYPOINT ["node", "src/main.ts"]
