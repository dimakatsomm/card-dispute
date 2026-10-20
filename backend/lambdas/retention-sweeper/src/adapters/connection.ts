import { err, ok, type Result } from '@cd/shared/fp';
import type { SecretResolver } from '@cd/shared/lambda';
import pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.ts';

export type DbTarget =
  | { readonly connectionString: string }
  | {
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly user: string;
      readonly password: string;
    };

export type ConnectionError =
  | { readonly kind: 'secret_unavailable'; readonly reason: 'not_found' | 'unavailable' }
  | { readonly kind: 'secret_malformed' };

const rdsSecretSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  dbname: z.string().min(1),
});

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const parseSecret = (raw: string): Result<DbTarget, ConnectionError> => {
  const parsed = rdsSecretSchema.safeParse(parseJson(raw));
  if (!parsed.success) return err({ kind: 'secret_malformed' });
  const s = parsed.data;
  return ok({ host: s.host, port: s.port, database: s.dbname, user: s.username, password: s.password });
};

export const resolveDbTarget = async (
  config: Pick<Config, 'DATABASE_URL' | 'DATABASE_SECRET_ID'>,
  resolveSecret: SecretResolver,
): Promise<Result<DbTarget, ConnectionError>> => {
  if (config.DATABASE_URL !== undefined) return ok({ connectionString: config.DATABASE_URL });
  const secret = await resolveSecret(config.DATABASE_SECRET_ID ?? '');
  return secret.ok ? parseSecret(secret.value) : err({ kind: 'secret_unavailable', reason: secret.error.kind });
};

const sqlStateOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : 'unknown';

export type PoolSettings = {
  readonly ssl: boolean;
  readonly onIdleError: (sqlState: string) => void;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
};

export const createPool = (target: DbTarget, settings: PoolSettings): pg.Pool => {
  const pool = new pg.Pool({
    ...target,
    max: 1,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
    ssl: settings.ssl ? { rejectUnauthorized: true } : false,
  });
  // A connection dropped while the Lambda is frozen would otherwise crash the runtime; the next query reconnects.
  pool.on('error', (e) => settings.onIdleError(sqlStateOf(e)));
  return pool;
};
