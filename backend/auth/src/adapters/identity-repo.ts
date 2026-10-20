import type pg from 'pg';
import { z } from 'zod';
import type { Identity } from '../core/token.ts';

export type IdentityRepo = {
  readonly findBySub: (cognitoSub: string) => Promise<Identity | null>;
  readonly ping: () => Promise<boolean>;
};

const rowSchema = z.object({
  auth_id: z.uuid(),
  user_id: z.uuid(),
  status: z.enum(['ACTIVE', 'DISABLED']),
});

export const createIdentityRepo = (pool: pg.Pool): IdentityRepo => ({
  findBySub: async (cognitoSub) => {
    const { rows } = await pool.query(
      'select auth_id, user_id, status from auth.auth_identity where cognito_sub = $1',
      [cognitoSub],
    );
    if (rows[0] === undefined) return null;
    const row = rowSchema.parse(rows[0]);
    return { authId: row.auth_id, userId: row.user_id, status: row.status };
  },
  ping: async () => {
    await pool.query('select 1');
    return true;
  },
});
