import type { AuthClient, Principal } from '@cd/auth-client';
import { createLogger, type Servers } from '@cd/shared';
import { err, ok } from '@cd/shared/fp';
import type pg from 'pg';
import { createUsersRepo } from '../../src/adapters/users-repo.ts';
import { buildServers } from '../../src/server.ts';
import { getContact } from '../../src/use-cases/get-contact.ts';
import { getMe } from '../../src/use-cases/get-me.ts';
import { listCards } from '../../src/use-cases/list-cards.ts';

export const FIXED_NOW = new Date('2026-10-19T12:00:00Z');

const EXP = Math.floor(FIXED_NOW.getTime() / 1000) + 900;

export const userToken = (userId: string): Principal => ({
  principalType: 'user',
  authId: '00000000-0000-4000-8000-0000000000aa',
  userId,
  scopes: [],
  exp: EXP,
});

export const serviceToken = (scopes: readonly string[]): Principal => ({
  principalType: 'service',
  clientId: 'svc-test',
  scopes: [...scopes],
  exp: EXP,
});

export const fakeAuthClient = (tokens: Readonly<Record<string, Principal>>): AuthClient => ({
  validate: async (token) => {
    const principal = tokens[token];
    return principal ? ok(principal) : err({ kind: 'invalid', reason: 'bad_signature' });
  },
});

export const buildTestServers = (pool: pg.Pool, tokens: Readonly<Record<string, Principal>>): Servers => {
  const users = createUsersRepo(pool);
  const now = (): Date => FIXED_NOW;
  return buildServers({
    authClient: fakeAuthClient(tokens),
    useCases: {
      getMe: getMe({ users, now }),
      listCards: listCards({ users, now }),
      getContact: getContact({ users }),
    },
    ready: users.ping,
    logger: createLogger({ level: 'silent' }),
  });
};

export const bearer = (token: string): { readonly authorization: string } => ({ authorization: `Bearer ${token}` });

export const keysDeep = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap(keysDeep)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)])
      : [];
