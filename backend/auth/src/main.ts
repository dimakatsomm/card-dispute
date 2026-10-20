import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import {
  createLogger,
  createServers,
  loadConfig,
  serverConfigSchema,
  type Env,
  type Servers,
} from '@cd/shared';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { createIdentityRepo } from './adapters/identity-repo.ts';
import { createJwtVerifier } from './adapters/jwt-verifier.ts';
import { clientAllowList, type ClientIds } from './core/token.ts';
import { serviceRoutes } from './routes/service.ts';
import { authenticateCaller } from './use-cases/authenticate-caller.ts';
import { validateToken } from './use-cases/validate-token.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const isHttps = (url: string): boolean => new URL(url).protocol === 'https:';

const clientIds = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  )
  .pipe(z.array(z.string()).min(1));

export const configSchema = serverConfigSchema
  .extend({
    DATABASE_URL: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    AUTH_ISSUER_URL: z.url(),
    // Containers fetch JWKS by service name while `iss` stays the browser-visible URL (local/README.md).
    AUTH_JWKS_URI: z.url().optional(),
    AUTH_USER_CLIENT_IDS: clientIds,
    AUTH_SERVICE_CLIENT_IDS: clientIds,
    // Local compose only: the mock issuer is plain http.
    AUTH_ALLOW_INSECURE_JWKS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((c) => clientAllowList({ user: c.AUTH_USER_CLIENT_IDS, service: c.AUTH_SERVICE_CLIENT_IDS }).ok, {
    message: 'a client id cannot be both a user and a service client',
    path: ['AUTH_SERVICE_CLIENT_IDS'],
  })
  .refine((c) => c.AUTH_ALLOW_INSECURE_JWKS || isHttps(c.AUTH_ISSUER_URL), {
    message: 'must be https unless AUTH_ALLOW_INSECURE_JWKS=true',
    path: ['AUTH_ISSUER_URL'],
  })
  .refine((c) => c.AUTH_ALLOW_INSECURE_JWKS || c.AUTH_JWKS_URI === undefined || isHttps(c.AUTH_JWKS_URI), {
    message: 'must be https unless AUTH_ALLOW_INSECURE_JWKS=true',
    path: ['AUTH_JWKS_URI'],
  });

export type AuthConfig = {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly clients: ClientIds;
  readonly allowInsecureJwks: boolean;
  readonly ports?: { readonly public: number; readonly service: number };
};

export type AuthRuntime = {
  readonly pool: pg.Pool;
  readonly fetch: typeof globalThis.fetch;
  readonly logger?: FastifyBaseLogger;
};

export const toAuthConfig = (c: z.output<typeof configSchema>): AuthConfig => ({
  issuer: c.AUTH_ISSUER_URL,
  jwksUri: c.AUTH_JWKS_URI ?? `${c.AUTH_ISSUER_URL.replace(/\/$/, '')}/.well-known/jwks.json`,
  clients: { user: c.AUTH_USER_CLIENT_IDS, service: c.AUTH_SERVICE_CLIENT_IDS },
  allowInsecureJwks: c.AUTH_ALLOW_INSECURE_JWKS,
  ports: { public: c.PUBLIC_PORT, service: c.SERVICE_PORT },
});

export const buildServers = (config: AuthConfig, runtime: AuthRuntime): Servers => {
  const clients = clientAllowList(config.clients);
  if (!clients.ok) throw new Error(`Invalid client allow-list: ${clients.error}`);
  const verifier = createJwtVerifier({
    issuer: config.issuer,
    jwksUri: config.jwksUri,
    fetch: runtime.fetch,
    allowInsecureJwks: config.allowInsecureJwks,
  });
  const identities = createIdentityRepo(runtime.pool);
  return createServers({
    // Auth exposes no customer routes (ADR-026).
    public: () => undefined,
    service: serviceRoutes({
      authenticateCaller: authenticateCaller({ verifyToken: verifier.verify, clients: clients.value }),
      validateToken: validateToken({
        verifyToken: verifier.verify,
        findIdentityBySub: identities.findBySub,
        clients: clients.value,
      }),
    }),
    ready: identities.ping,
    ...(config.ports ? { ports: config.ports } : {}),
    ...(runtime.logger ? { logger: runtime.logger } : {}),
  });
};

const migrateConfigSchema = z.object({ MIGRATOR_DATABASE_URL: z.string().min(1) });

const runMigrate = async (env: Env, log: FastifyBaseLogger): Promise<number> => {
  const { MIGRATOR_DATABASE_URL } = loadConfig(migrateConfigSchema, env);
  const result = await migrate({
    schema: 'auth',
    dir: MIGRATIONS_DIR,
    connectionString: MIGRATOR_DATABASE_URL,
  });
  if (!result.ok) {
    log.error({ error: result.error }, 'migration failed');
    return 1;
  }
  log.info({ applied: result.value.applied }, 'migrations applied');
  return 0;
};

const serve = async (env: Env, log: FastifyBaseLogger): Promise<number> => {
  const config = loadConfig(configSchema, env);
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  });
  // An idle-client error would otherwise crash the process; /ready and the next query surface it.
  pool.on('error', (e) => log.warn({ message: e.message }, 'idle database client error'));
  const servers = buildServers(toAuthConfig(config), { pool, fetch: globalThis.fetch, logger: log });
  const shutdown = async (): Promise<void> => {
    await servers.close();
    await pool.end();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await servers.listen();
  return 0;
};

export const main = async (command: string | undefined, env: Env): Promise<number> => {
  const log = createLogger({ level: serverConfigSchema.shape.LOG_LEVEL.catch('info').parse(env.LOG_LEVEL) });
  try {
    switch (command ?? 'serve') {
      case 'serve':
        return await serve(env, log);
      case 'migrate':
        return await runMigrate(env, log);
      default:
        log.error({ command }, 'unknown command: expected serve or migrate');
        return 1;
    }
  } catch (e) {
    log.error({ message: e instanceof Error ? e.message : String(e) }, 'auth failed to start');
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await main(process.argv[2], process.env);
}
