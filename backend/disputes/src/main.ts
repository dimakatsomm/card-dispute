import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAuthClient, createHttpClient, createServiceTokenProvider, type Fetch } from '@cd/auth-client';
import { migrate, type MigrateResult } from '@cd/db';
import { createLogger, loadConfig, type Env, type Servers } from '@cd/shared';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { createPool, type Connectable } from './adapters/db.ts';
import { UPSTREAM_DEADLINE_MS } from './adapters/deadline.ts';
import { createDisputeRepo } from './adapters/dispute-repo.ts';
import { createEventPublisher, createSqsSend, type SendMessage } from './adapters/event-publisher.ts';
import { withValidateDeadline } from './adapters/service-client.ts';
import { createTransactionsClient } from './adapters/transactions-client.ts';
import { createUploadSigner, guardSigner, type PresignUploads } from './adapters/upload-signer.ts';
import { createUsersClient } from './adapters/users-client.ts';
import { createApp } from './app.ts';
import { loadDisputesConfig, migrateConfigSchema, type Config } from './config.ts';
import { addEvidence } from './use-cases/add-evidence.ts';
import { createDispute } from './use-cases/create-dispute.ts';
import { getDispute } from './use-cases/get-dispute.ts';
import { listDisputes } from './use-cases/list-disputes.ts';
import { lookupDisputes } from './use-cases/lookup-disputes.ts';
import { updateDispute } from './use-cases/update-dispute.ts';

export type Infra = {
  readonly config: Config;
  readonly pool: Connectable & Pick<pg.Pool, 'query'>;
  readonly fetch: Fetch;
  readonly sendMessage: SendMessage;
  readonly presignUploads: PresignUploads;
  readonly logger: FastifyBaseLogger;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly sleep: (ms: number) => Promise<void>;
};

export const composeServers = (infra: Infra): Servers => {
  const { config, logger } = infra;
  const nowMs = (): number => infra.now().getTime();
  // One token per audience, so a token leaked by one callee cannot be replayed against another.
  const tokens = (scope: string) =>
    createServiceTokenProvider({
      tokenUrl: config.TOKEN_URL,
      clientId: config.SERVICE_CLIENT_ID,
      clientSecret: config.SERVICE_CLIENT_SECRET,
      scopes: [scope],
      fetch: infra.fetch,
      now: nowMs,
    });
  const http = createHttpClient({ fetch: infra.fetch });
  const authTokens = tokens('auth/validate');

  const authClient = withValidateDeadline(
    createAuthClient({
      authUrl: config.AUTH_URL,
      fetch: infra.fetch,
      now: nowMs,
      getServiceToken: authTokens.getToken,
      invalidateServiceToken: authTokens.invalidate,
    }),
    UPSTREAM_DEADLINE_MS,
  );
  const transactions = createTransactionsClient({
    baseUrl: config.TRANSACTIONS_SERVICE_URL,
    http,
    tokens: tokens('transactions/read'),
    log: logger,
    timeoutMs: UPSTREAM_DEADLINE_MS,
  });
  const users = createUsersClient({
    baseUrl: config.USERS_SERVICE_URL,
    http,
    tokens: tokens('users/cards.read'),
    log: logger,
    timeoutMs: UPSTREAM_DEADLINE_MS,
  });
  const repo = createDisputeRepo(infra.pool);
  const publish = createEventPublisher({
    send: infra.sendMessage,
    queueUrl: config.NOTIFICATIONS_QUEUE_URL,
    log: logger,
    sleep: infra.sleep,
    now: infra.now,
  });

  const signUploads = guardSigner(infra.presignUploads, logger);

  const useCases = {
    createDispute: createDispute({
      findTransaction: transactions.findTransaction,
      findCard: users.findCard,
      transact: repo.transact,
      signUploads,
      publish,
      newId: infra.newId,
    }),
    addEvidence: addEvidence({ transact: repo.transact, signUploads }),
    updateDispute: updateDispute({
      transact: repo.transact,
      findTransaction: transactions.findTransaction,
      publish,
      newId: infra.newId,
    }),
    getDispute: getDispute({
      findLatestWithHistory: repo.findLatestWithHistory,
      findTransaction: transactions.findTransaction,
    }),
    listDisputes: listDisputes({
      listTransactionIds: repo.listTransactionIds,
      listPage: repo.listPage,
      findTransactions: transactions.findTransactions,
    }),
    lookupDisputes: lookupDisputes({ lookupRefs: repo.lookupRefs }),
  };

  return createApp({
    authClient,
    useCases,
    logger,
    ports: { public: config.PUBLIC_PORT, service: config.SERVICE_PORT },
    ready: async () => {
      await infra.pool.query('select 1');
      return true;
    },
  });
};

// Browsers sign against a host they can reach, which locally differs from the docker-internal S3 endpoint.
export const createConfiguredUploadSigner = (config: Config, now: () => Date): PresignUploads => {
  const endpoint = config.S3_PRESIGN_ENDPOINT ?? config.S3_ENDPOINT;
  return createUploadSigner({
    region: config.AWS_REGION,
    bucket: config.QUARANTINE_BUCKET,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    now,
    ...(endpoint === undefined ? {} : { endpoint }),
  });
};

export const startService = async (env: Env): Promise<{ readonly close: () => Promise<void> }> => {
  const config = loadDisputesConfig(env);
  const logger = createLogger({ level: config.LOG_LEVEL });
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: config.DB_IDLE_TIMEOUT_MS,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  });
  const now = (): Date => new Date();
  const servers = composeServers({
    config,
    pool,
    fetch: globalThis.fetch,
    sendMessage: createSqsSend({
      region: config.AWS_REGION,
      ...(config.SQS_ENDPOINT === undefined ? {} : { endpoint: config.SQS_ENDPOINT }),
    }),
    presignUploads: createConfiguredUploadSigner(config, now),
    logger,
    now,
    newId: randomUUID,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  });
  await servers.listen();
  return {
    close: async () => {
      await servers.close();
      await pool.end();
    },
  };
};

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export const runMigrations = async (env: Env): Promise<MigrateResult> => {
  const { MIGRATOR_DATABASE_URL } = loadConfig(migrateConfigSchema, env);
  return migrate({ schema: 'disputes', dir: MIGRATIONS_DIR, connectionString: MIGRATOR_DATABASE_URL });
};
