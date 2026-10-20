import { err, ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import {
  classifyClaims,
  clientAllowList,
  type ClientAllowList,
  type VerifiedClaims,
} from '../../src/core/token.ts';

const unwrap = (r: ReturnType<typeof clientAllowList>): ClientAllowList => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const clients = unwrap(clientAllowList({ user: ['spa'], service: ['svc-disputes'] }));

describe('clientAllowList', () => {
  it.each([
    ['disjoint lists', { user: ['spa'], service: ['svc-a'] }, true],
    ['a client id in both lists', { user: ['spa', 'svc-a'], service: ['svc-a'] }, 'overlapping_client_ids'],
    ['an empty service list', { user: ['spa'], service: [] }, 'empty_allow_list'],
  ])('%s', (_name, ids, expected) => {
    const result = clientAllowList(ids);
    expect(result.ok ? true : result.error).toBe(expected);
  });
});

const claims = (overrides: Partial<VerifiedClaims>): VerifiedClaims => ({
  tokenUse: 'access',
  clientId: 'spa',
  sub: 'sub-1',
  scope: undefined,
  exp: 1_760_000_000,
  ...overrides,
});

describe('classifyClaims', () => {
  it.each<[string, VerifiedClaims, ReturnType<typeof classifyClaims>]>([
    ['user access token', claims({}), ok({ kind: 'user', sub: 'sub-1', scopes: [], exp: 1_760_000_000 })],
    [
      'service token without sub (mock issuer)',
      claims({ clientId: 'svc-disputes', sub: undefined, scope: 'auth/validate  users/cards.read' }),
      ok({
        kind: 'service',
        clientId: 'svc-disputes',
        scopes: ['auth/validate', 'users/cards.read'],
        exp: 1_760_000_000,
      }),
    ],
    [
      'service token whose sub is the client id (Cognito)',
      claims({ clientId: 'svc-disputes', sub: 'svc-disputes' }),
      ok({ kind: 'service', clientId: 'svc-disputes', scopes: [], exp: 1_760_000_000 }),
    ],
    ['id token', claims({ tokenUse: 'id' }), err('wrong_token_use')],
    ['missing token_use', claims({ tokenUse: undefined }), err('wrong_token_use')],
    ['missing client_id', claims({ clientId: undefined }), err('wrong_client')],
    ['client not on either allow-list', claims({ clientId: 'other' }), err('wrong_client')],
    ['user client without sub', claims({ sub: undefined }), err('unknown_subject')],
    ['no exp claim', claims({ exp: undefined }), err('expired')],
  ])('%s', (_name, input, expected) => {
    expect(classifyClaims(input, clients)).toEqual(expected);
  });
});
