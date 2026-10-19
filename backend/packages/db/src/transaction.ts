import type { Pool, PoolClient } from 'pg';

export const withTransaction = async <T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  // Set when the connection state is unknown, so the client is destroyed instead of pooled.
  let broken = false;
  try {
    await client.query('begin').catch((e: unknown) => {
      broken = true;
      throw e;
    });
    const value = await fn(client);
    await client.query('commit');
    return value;
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
