import { err, ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import {
  agentPrincipal,
  classifyClaims,
  clientAllowList,
  userPrincipal,
  type AgentIdentity,
  type ClientAllowList,
  type ClientIds,
  type Identity,
  type TokenSubject,
  type VerifiedClaims,
} from '../../src/core/token.ts';

const unwrap = (r: ReturnType<typeof clientAllowList>): ClientAllowList => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const clients = unwrap(clientAllowList({ user: ['spa'], service: ['svc-disputes'], agent: ['backoffice'] }));

describe('clientAllowList', () => {
  it.each<[string, ClientIds, true | string]>([
    ['disjoint lists', { user: ['spa'], service: ['svc-a'], agent: ['backoffice'] }, true],
    [
      'user and service overlap',
      { user: ['spa', 'svc-a'], service: ['svc-a'], agent: ['bo'] },
      'overlapping_client_ids',
    ],
    [
      'user and agent overlap',
      { user: ['spa'], service: ['svc-a'], agent: ['spa'] },
      'overlapping_client_ids',
    ],
    [
      'service and agent overlap',
      { user: ['spa'], service: ['svc-a'], agent: ['svc-a'] },
      'overlapping_client_ids',
    ],
    ['an empty service list', { user: ['spa'], service: [], agent: ['bo'] }, 'empty_allow_list'],
    ['an empty agent list', { user: ['spa'], service: ['svc-a'], agent: [] }, 'empty_allow_list'],
  ])('%s', (_name, ids, expected) => {
    const result = clientAllowList(ids);
    expect(result.ok ? true : result.error).toBe(expected);
  });
});

const EXP = 1_760_000_000;

const claims = (overrides: Partial<VerifiedClaims>): VerifiedClaims => ({
  tokenUse: 'access',
  clientId: 'spa',
  sub: 'sub-1',
  scope: undefined,
  exp: EXP,
  groups: undefined,
  ...overrides,
});

const agentClaims = (overrides: Partial<VerifiedClaims> = {}): VerifiedClaims =>
  claims({ clientId: 'backoffice', scope: 'openid profile email', groups: ['agents'], ...overrides });

describe('classifyClaims', () => {
  it.each<[string, VerifiedClaims, ReturnType<typeof classifyClaims>]>([
    ['user access token', claims({}), ok({ kind: 'user', sub: 'sub-1', scopes: [], exp: EXP })],
    [
      'service token without sub (mock issuer)',
      claims({ clientId: 'svc-disputes', sub: undefined, scope: 'auth/validate  users/cards.read' }),
      ok({
        kind: 'service',
        clientId: 'svc-disputes',
        scopes: ['auth/validate', 'users/cards.read'],
        exp: EXP,
      }),
    ],
    [
      'service token whose sub is the client id (Cognito)',
      claims({ clientId: 'svc-disputes', sub: 'svc-disputes' }),
      ok({ kind: 'service', clientId: 'svc-disputes', scopes: [], exp: EXP }),
    ],
    ['id token', claims({ tokenUse: 'id' }), err('wrong_token_use')],
    ['missing token_use', claims({ tokenUse: undefined }), err('wrong_token_use')],
    ['missing client_id', claims({ clientId: undefined }), err('wrong_client')],
    ['client not on any allow-list', claims({ clientId: 'other' }), err('wrong_client')],
    ['user client without sub', claims({ sub: undefined }), err('unknown_subject')],
    ['no exp claim', claims({ exp: undefined }), err('expired')],
    ['agent-client token in group agents', agentClaims(), ok({ kind: 'agent', sub: 'sub-1', exp: EXP })],
    [
      'agent-client token with agents among other groups',
      agentClaims({ groups: ['support', 'agents'] }),
      ok({ kind: 'agent', sub: 'sub-1', exp: EXP }),
    ],
    ['agent-client token without groups', agentClaims({ groups: undefined }), err('unknown_subject')],
    ['agent-client token with empty groups', agentClaims({ groups: [] }), err('unknown_subject')],
    ['agent-client token in another group only', agentClaims({ groups: ['Agents'] }), err('unknown_subject')],
    ['agent-client token without sub', agentClaims({ sub: undefined }), err('unknown_subject')],
    ['agent-client id token', agentClaims({ tokenUse: 'id' }), err('wrong_token_use')],
    ['agent-client token without exp', agentClaims({ exp: undefined }), err('expired')],
    [
      'user-client (spa) token carrying group agents stays a customer',
      claims({ groups: ['agents'] }),
      ok({ kind: 'user', sub: 'sub-1', scopes: [], exp: EXP }),
    ],
    [
      'service-client token carrying group agents stays a service',
      claims({ clientId: 'svc-disputes', groups: ['agents'] }),
      ok({ kind: 'service', clientId: 'svc-disputes', scopes: [], exp: EXP }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(classifyClaims(input, clients)).toEqual(expected);
  });
});

const AGENT_ID = '01990000-0000-7000-8000-0000000000a1';
const identity = (status: Identity['status']): Identity => ({
  authId: '01990000-0000-7000-8000-000000000001',
  userId: '01990000-0000-7000-8000-000000000002',
  status,
});
const agentRow = (status: AgentIdentity['status']): AgentIdentity => ({
  agentId: AGENT_ID,
  displayName: 'Naledi M.',
  status,
});

describe('agentPrincipal', () => {
  const subject: Extract<TokenSubject, { kind: 'agent' }> = { kind: 'agent', sub: 'sub-1', exp: EXP };

  it.each<[string, AgentIdentity | null, Identity | null, ReturnType<typeof agentPrincipal>]>([
    [
      'ACTIVE agent row',
      agentRow('ACTIVE'),
      null,
      ok({ principalType: 'agent', agentId: AGENT_ID, displayName: 'Naledi M.', scopes: [], exp: EXP }),
    ],
    ['no agent row', null, null, err('unknown_subject')],
    ['no agent row but a customer row', null, identity('ACTIVE'), err('unknown_subject')],
    ['DISABLED agent row', agentRow('DISABLED'), null, err('disabled')],
    ['agent row and customer row', agentRow('ACTIVE'), identity('ACTIVE'), err('ambiguous_role')],
    ['agent row and DISABLED customer row', agentRow('ACTIVE'), identity('DISABLED'), err('ambiguous_role')],
  ])('%s', (_name, agent, customer, expected) => {
    expect(agentPrincipal(subject, agent, customer)).toEqual(expected);
  });
});

describe('userPrincipal', () => {
  const subject: Extract<TokenSubject, { kind: 'user' }> = {
    kind: 'user',
    sub: 'sub-1',
    scopes: ['openid'],
    exp: EXP,
  };

  it.each<[string, Identity | null, AgentIdentity | null, ReturnType<typeof userPrincipal>]>([
    [
      'ACTIVE customer row',
      identity('ACTIVE'),
      null,
      ok({
        principalType: 'user',
        authId: identity('ACTIVE').authId,
        userId: identity('ACTIVE').userId,
        scopes: ['openid'],
        exp: EXP,
      }),
    ],
    ['no customer row', null, null, err('unknown_subject')],
    ['only an agent row (agent signing in on spa)', null, agentRow('ACTIVE'), err('unknown_subject')],
    ['DISABLED customer row', identity('DISABLED'), null, err('disabled')],
    ['customer row and agent row', identity('ACTIVE'), agentRow('ACTIVE'), err('ambiguous_role')],
    ['customer row and DISABLED agent row', identity('ACTIVE'), agentRow('DISABLED'), err('ambiguous_role')],
  ])('%s', (_name, customer, agent, expected) => {
    expect(userPrincipal(subject, customer, agent)).toEqual(expected);
  });
});
