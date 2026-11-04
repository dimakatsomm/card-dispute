import { ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import {
  clientAllowList,
  type AgentIdentity,
  type Identity,
  type VerifiedClaims,
} from '../../src/core/token.ts';
import { validateToken } from '../../src/use-cases/validate-token.ts';

const allowList = clientAllowList({ user: ['spa'], service: ['svc-disputes'], agent: ['backoffice'] });
if (!allowList.ok) throw new Error(allowList.error);

const claimsFor = (clientId: string): VerifiedClaims => ({
  tokenUse: 'access',
  clientId,
  sub: 'sub-1',
  scope: undefined,
  exp: 1_760_000_000,
  groups: ['agents'],
});

const activeIdentity: Identity = {
  authId: '01990000-0000-7000-8000-000000000001',
  userId: '01990000-0000-7000-8000-000000000002',
  status: 'ACTIVE',
};
const activeAgent: AgentIdentity = { agentId: '01990000-0000-7000-8000-0000000000a1', status: 'ACTIVE' };

const lookupDown = (): Promise<never> => Promise.reject(new Error('database unavailable'));

describe('validateToken fails closed when an identity lookup fails', () => {
  it.each<[string, string, 'identity' | 'agent']>([
    ['user-client subject, agent lookup fails', 'spa', 'agent'],
    ['agent-client subject, agent lookup fails', 'backoffice', 'agent'],
    ['agent-client subject, customer lookup fails', 'backoffice', 'identity'],
  ])('%s', async (_name, clientId, failing) => {
    const validate = validateToken({
      verifyToken: async () => ok(claimsFor(clientId)),
      findIdentityBySub: failing === 'identity' ? lookupDown : async () => activeIdentity,
      findAgentBySub: failing === 'agent' ? lookupDown : async () => activeAgent,
      clients: allowList.value,
    });
    await expect(validate('token')).rejects.toThrow('database unavailable');
  });
});
