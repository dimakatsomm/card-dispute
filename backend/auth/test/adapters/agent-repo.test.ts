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
  it('reads agent_id, display_name and status by cognito sub, and null for an unknown sub', async () => {
    const activeId = await db.seedAgent({ sub: 'agent-active', displayName: 'Active A.', status: 'ACTIVE' });
    const disabledId = await db.seedAgent({
      sub: 'agent-disabled',
      displayName: 'Disabled D.',
      status: 'DISABLED',
    });

    expect(await repo.findBySub('agent-active')).toEqual({
      agentId: activeId,
      displayName: 'Active A.',
      status: 'ACTIVE',
    });
    expect(await repo.findBySub('agent-disabled')).toEqual({
      agentId: disabledId,
      displayName: 'Disabled D.',
      status: 'DISABLED',
    });
    expect(await repo.findBySub('agent-unknown')).toBeNull();
  });

  it('accepts an 80-character display name made of astral characters, as the DB check counts them', async () => {
    const displayName = '\u{1F600}'.repeat(80);
    const agentId = await db.seedAgent({ sub: 'agent-astral', displayName, status: 'ACTIVE' });

    expect(await repo.findBySub('agent-astral')).toEqual({ agentId, displayName, status: 'ACTIVE' });
  });
});
