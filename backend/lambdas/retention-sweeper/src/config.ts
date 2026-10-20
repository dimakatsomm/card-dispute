import { loadConfig, type Env } from '@cd/shared/lambda';
import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_SECRET_ID: z.string().min(1).optional(),
    DB_SSL: booleanFlag,
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
    SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
    METRICS_NAMESPACE: z.string().min(1).default('cd/retention-sweeper'),
    AWS_REGION: z.string().min(1).default('af-south-1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .refine((c) => (c.DATABASE_URL === undefined) !== (c.DATABASE_SECRET_ID === undefined), {
    message: 'set exactly one of DATABASE_URL or DATABASE_SECRET_ID',
  })
  // Plaintext is allowed only for a local DATABASE_URL; the AWS secret path must use TLS.
  .refine((c) => c.DATABASE_SECRET_ID === undefined || c.DB_SSL, {
    message: 'DB_SSL must be true when DATABASE_SECRET_ID is set',
  });

export type Config = z.output<typeof configSchema>;

export const loadSweeperConfig = (env: Env): Config => loadConfig(configSchema, env);
