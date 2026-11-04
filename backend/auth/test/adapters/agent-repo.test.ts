import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRepo, type AgentRepo } from '../../src/adapters/agent-repo.ts';
import { startAuthDb, type AuthDb } from '../support/db.ts';

let db: AuthDb;
let repo: AgentRepo;

beforeAll(async () => {
  db = await startAuthDb();
  repo = createAgentRepo(db.appPool);
});

afterAll(async () => {
  await db?.stop();
});

describe('agent repo (auth_app role, SELECT only)', () => {
  it('reads agent_id and status by cognito sub, and null for an unknown sub', async () => {
    const activeId = await db.seedAgent({ sub: 'agent-active', displayName: 'Active A.', status: 'ACTIVE' });
    const disabledId = await db.seedAgent({
      sub: 'agent-disabled',
      displayName: 'Disabled D.',
      status: 'DISABLED',
    });

    expect(await repo.findBySub('agent-active')).toEqual({ agentId: activeId, status: 'ACTIVE' });
    expect(await repo.findBySub('agent-disabled')).toEqual({ agentId: disabledId, status: 'DISABLED' });
    expect(await repo.findBySub('agent-unknown')).toBeNull();
  });
});
