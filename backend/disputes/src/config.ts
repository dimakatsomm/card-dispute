import { loadConfig, serverConfigSchema, type Env } from '@cd/shared';
import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const configSchema = serverConfigSchema.extend({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  AUTH_URL: z.url(),
  TRANSACTIONS_SERVICE_URL: z.url(),
  USERS_SERVICE_URL: z.url(),
  TOKEN_URL: z.url(),
  SERVICE_CLIENT_ID: z.string().min(1),
  SERVICE_CLIENT_SECRET: z.string().min(1),
  AWS_REGION: z.string().min(1).default('eu-north-1'),
  S3_ENDPOINT: z.url().optional(),
  S3_PRESIGN_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: booleanFlag,
  QUARANTINE_BUCKET: z.string().min(3),
  SQS_ENDPOINT: z.url().optional(),
  NOTIFICATIONS_QUEUE_URL: z.url(),
});

export type Config = z.output<typeof configSchema>;

export const loadDisputesConfig = (env: Env = process.env): Config => loadConfig(configSchema, env);

export const migrateConfigSchema = z.object({ MIGRATOR_DATABASE_URL: z.string().min(1) });
