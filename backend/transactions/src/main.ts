import {
  createAuthClient,
  createHttpClient,
  createServiceTokenProvider,
  type Fetch,
} from '@cd/auth-client';
import { createLogger, loadConfig, type Servers } from '@cd/shared';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { createTransactionRepo } from './adapters/transaction-repo.ts';
import { createDisputesClient, createUsersClient } from './adapters/upstream.ts';
import { createApp } from './app.ts';
import { configSchema, type Config } from './config.ts';
import { listTransactions } from './use-cases/list-transactions.ts';
import { lookupTransactions } from './use-cases/lookup-transactions.ts';

const UPSTREAM_TIMEOUT_MS = 2000;
const CARDS_CACHE_TTL_MS = 60_000;
const SERVICE_SCOPES = ['auth/validate', 'users/cards.read', 'disputes/read'];

export type Runtime = {
  readonly config: Config;
  readonly pool: pg.Pool;
  readonly fetch: Fetch;
  readonly nowMs: () => number;
  readonly logger: FastifyBaseLogger;
};

export const compose = (rt: Runtime): Servers => {
  const { config } = rt;
  const tokens = createServiceTokenProvider({
    tokenUrl: config.TOKEN_URL,
    clientId: config.SERVICE_CLIENT_ID,
    clientSecret: config.SERVICE_CLIENT_SECRET,
    scopes: SERVICE_SCOPES,
    fetch: rt.fetch,
    now: rt.nowMs,
  });
  const authClient = createAuthClient({
    authUrl: config.AUTH_URL,
    fetch: rt.fetch,
    now: rt.nowMs,
    getServiceToken: tokens.getToken,
    invalidateServiceToken: tokens.invalidate,
  });
  const upstream = {
    http: createHttpClient({ fetch: rt.fetch, timeoutMs: UPSTREAM_TIMEOUT_MS }),
    getToken: tokens.getToken,
    invalidateToken: tokens.invalidate,
    log: rt.logger,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  };
  const users = createUsersClient({
    ...upstream,
    baseUrl: config.USERS_SERVICE_URL,
    cacheTtlMs: CARDS_CACHE_TTL_MS,
    nowMs: rt.nowMs,
  });
  const disputes = createDisputesClient({ ...upstream, baseUrl: config.DISPUTES_SERVICE_URL });
  const repo = createTransactionRepo(rt.pool);

  return createApp({
    authClient,
    logger: rt.logger,
    ready: repo.ping,
    ports: { public: config.PUBLIC_PORT, service: config.SERVICE_PORT },
    listTransactions: listTransactions({
      listPage: repo.listPage,
      dbNow: repo.now,
      fetchCards: users.fetchCards,
      fetchDisputes: disputes.fetchDisputes,
    }),
    lookupTransactions: lookupTransactions({ lookup: repo.lookup }),
  });
};

const start = async (): Promise<void> => {
  const config = loadConfig(configSchema);
  const logger = createLogger({ level: config.LOG_LEVEL });
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  });
  // An idle-client error would otherwise crash the process; the next query surfaces real failures.
  pool.on('error', (e) => {
    logger.warn({ message: e.message }, 'idle database client error');
  });
  const servers = compose({ config, pool, fetch: globalThis.fetch, nowMs: Date.now, logger });
  const shutdown = async (): Promise<void> => {
    await servers.close();
    await pool.end();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await servers.listen();
};

if (import.meta.main) await start();
