import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger, createSecretResolver, emitMetric, type Env } from '@cd/shared/lambda';
import { createPool, resolveDbTarget } from './adapters/connection.ts';
import { createRetentionStore, type RetentionPool } from './adapters/retention-store.ts';
import { loadSweeperConfig } from './config.ts';
import { createHandler } from './handler.ts';
import { sweepRetention, type SweepSummary } from './use-cases/sweep-retention.ts';

export type SweeperHandler = (event?: unknown) => Promise<SweepSummary>;

export type ComposeInput = {
  readonly pool: RetentionPool;
  readonly batchSize: number;
  readonly namespace: string;
  readonly log: ReturnType<typeof createLogger>;
  readonly now: () => Date;
};

export const composeHandler = (input: ComposeInput): SweeperHandler =>
  createHandler({
    now: input.now,
    sweep: sweepRetention({
      store: createRetentionStore(input.pool),
      batchSize: input.batchSize,
      log: input.log,
      metric: (name, value) =>
        emitMetric(input.log, { namespace: input.namespace, name, value, timestamp: input.now().getTime() }),
    }),
  });

const init = async (env: Env): Promise<SweeperHandler> => {
  const config = loadSweeperConfig(env);
  const target = await resolveDbTarget(
    config,
    createSecretResolver(new SecretsManagerClient({ region: config.AWS_REGION })),
  );
  if (!target.ok) throw new Error(`retention-sweeper cannot resolve DB credentials: ${target.error.kind}`);
  const log = createLogger({ level: config.LOG_LEVEL });
  return composeHandler({
    pool: createPool(target.value, {
      ssl: config.DB_SSL,
      onIdleError: (sqlState) => log.debug({ sqlState }, 'idle db client error'),
      connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    }),
    batchSize: config.SWEEP_BATCH_SIZE,
    namespace: config.METRICS_NAMESPACE,
    log,
    now: () => new Date(),
  });
};

// Built on first invocation and reused while the container is warm; a failed init is retried on the next one.
export const createLambdaHandler = (env: Env): SweeperHandler => {
  let ready: Promise<SweeperHandler> | undefined;
  return async (event) => {
    ready ??= init(env).catch((e: unknown) => {
      ready = undefined;
      throw e;
    });
    return (await ready)(event);
  };
};

export const handler = createLambdaHandler(process.env);
