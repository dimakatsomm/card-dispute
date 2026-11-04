import type pg from 'pg';
import { z } from 'zod';
import type { AgentIdentity } from '../core/token.ts';

export type AgentRepo = {
  readonly findBySub: (cognitoSub: string) => Promise<AgentIdentity | null>;
};

const rowSchema = z.object({
  agent_id: z.uuid(),
  status: z.enum(['ACTIVE', 'DISABLED']),
});

export const createAgentRepo = (pool: pg.Pool): AgentRepo => ({
  findBySub: async (cognitoSub) => {
    const { rows } = await pool.query(
      'select agent_id, status from auth.agent_identity where cognito_sub = $1',
      [cognitoSub],
    );
    if (rows[0] === undefined) return null;
    const row = rowSchema.parse(rows[0]);
    return { agentId: row.agent_id, status: row.status };
  },
});
