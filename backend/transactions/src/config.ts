import { serverConfigSchema } from '@cd/shared';
import { z } from 'zod';

const baseUrl = z.url().transform((u) => u.replace(/\/+$/, ''));

export const configSchema = serverConfigSchema.extend({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  AUTH_URL: baseUrl,
  USERS_SERVICE_URL: baseUrl,
  DISPUTES_SERVICE_URL: baseUrl,
  TOKEN_URL: z.url(),
  SERVICE_CLIENT_ID: z.string().min(1),
  SERVICE_CLIENT_SECRET: z.string().min(1),
});

export type Config = z.output<typeof configSchema>;
