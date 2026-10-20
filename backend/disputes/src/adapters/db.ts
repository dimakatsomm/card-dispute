import type { Result } from '@cd/shared/fp';
import pg from 'pg';

export type Connectable = Pick<pg.Pool, 'connect'>;

export type PoolOptions = {
  readonly connectionString: string;
  readonly max: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
};

export const createPool = (options: PoolOptions): pg.Pool => {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.connectTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
  });
  // An idle-client error would otherwise crash the process; the next query surfaces real failures.
  pool.on('error', () => undefined);
  return pool;
};

// Commits only an ok Result; an err Result or a throw rolls back, so a business rejection never half-writes.
export const inTransaction = async <T, E>(
  pool: Connectable,
  work: (client: pg.PoolClient) => Promise<Result<T, E>>,
): Promise<Result<T, E>> => {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin').catch((e: unknown) => {
      broken = true;
      throw e;
    });
    const result = await work(client);
    await client.query(result.ok ? 'commit' : 'rollback');
    return result;
  } catch (e) {
    if (!broken) {
      await client.query('rollback').catch(() => {
        broken = true;
      });
    }
    throw e;
  } finally {
    client.release(broken);
  }
};
