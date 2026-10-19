import { createAuthClient, createServiceTokenProvider } from '@cd/auth-client';
import { createLogger, loadConfig } from '@cd/shared';
import pg from 'pg';
import { createUsersRepo } from './adapters/users-repo.ts';
import { usersConfigSchema } from './config.ts';
import { buildServers } from './server.ts';
import { getContact } from './use-cases/get-contact.ts';
import { getMe } from './use-cases/get-me.ts';
import { listCards } from './use-cases/list-cards.ts';

const config = loadConfig(usersConfigSchema);
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

const now = (): Date => new Date();
const fetch = globalThis.fetch;

const serviceTokens = createServiceTokenProvider({
  tokenUrl: config.TOKEN_URL,
  clientId: config.SERVICE_CLIENT_ID,
  clientSecret: config.SERVICE_CLIENT_SECRET,
  scopes: ['auth/validate'],
  fetch,
  now: Date.now,
});

const authClient = createAuthClient({
  authUrl: config.AUTH_URL,
  fetch,
  now: Date.now,
  getServiceToken: serviceTokens.getToken,
});

const users = createUsersRepo(pool);

const servers = buildServers({
  authClient,
  useCases: {
    getMe: getMe({ users, now }),
    listCards: listCards({ users, now }),
    getContact: getContact({ users }),
  },
  ready: users.ping,
  logger,
  ports: { public: config.PUBLIC_PORT, service: config.SERVICE_PORT },
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await servers.close();
  await pool.end();
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((e: unknown) => {
      logger.error({ message: e instanceof Error ? e.message : String(e) }, 'shutdown failed');
      process.exitCode = 1;
    });
  });
}

await servers.listen();
