# Build context is the repo root (compose sets it) so the pnpm lockfile pins fastify.
FROM node:24.22.0-alpine
WORKDIR /app
RUN npm install --global pnpm@11.9.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY local/mock-issuer/package.json local/mock-issuer/
RUN pnpm install --frozen-lockfile --prod --filter @cd/mock-issuer
COPY local/mock-issuer/src local/mock-issuer/src
USER node
WORKDIR /app/local/mock-issuer
ENV PORT=55900
EXPOSE 55900
CMD ["node", "src/main.ts"]
