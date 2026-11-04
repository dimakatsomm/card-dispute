import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type SeedUser = {
  readonly key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  readonly sub: string;
  readonly username: string;
  readonly label: string;
  readonly groups: ReadonlyArray<string>;
};

export type Client = {
  readonly clientId: string;
  readonly secret: string | null;
  readonly allowedScopes: ReadonlyArray<string>;
  readonly redirectUris: ReadonlyArray<string>;
  readonly emitsGroups: boolean;
};

export type Config = {
  readonly port: number;
  readonly issuer: string;
  readonly testHooks: boolean;
  readonly corsOrigins: ReadonlyArray<string>;
  readonly privateKey: KeyObject;
  readonly clients: ReadonlyArray<Client>;
};

export const AGENTS_GROUP = 'agents';

// D-05 and BO-01 seed data reuse these exact subs (agents: docs/02 "Seeded agents").
export const SEED_USERS: ReadonlyArray<SeedUser> = [
  {
    key: 'A',
    sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    username: 'thandi.nkosi',
    label: 'Thandi Nkosi',
    groups: [],
  },
  {
    key: 'B',
    sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    username: 'sipho.dlamini',
    label: 'Sipho Dlamini',
    groups: [],
  },
  {
    key: 'C',
    sub: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    username: 'lerato.mokoena',
    label: 'Lerato Mokoena',
    groups: [],
  },
  {
    key: 'D',
    sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    username: 'dumisani.zulu',
    label: 'Dumisani Zulu (disabled in auth seed)',
    groups: [],
  },
  {
    key: 'E',
    sub: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    username: 'agent.naledi',
    label: 'Naledi M. (agent)',
    groups: [AGENTS_GROUP],
  },
  {
    key: 'F',
    sub: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    username: 'agent.pieter',
    label: 'Pieter V. (agent, disabled in auth seed)',
    groups: [AGENTS_GROUP],
  },
];

export const SPA_CLIENT_ID = 'spa';
export const BACKOFFICE_CLIENT_ID = 'backoffice';

const USER_SCOPES: ReadonlyArray<string> = ['openid', 'profile', 'email'];

const AUTH_VALIDATE = 'auth/validate';

// Mirrors the scope grants in docs/05-security.md.
const SERVICE_GRANTS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['svc-users', [AUTH_VALIDATE]],
  ['svc-transactions', [AUTH_VALIDATE, 'users/cards.read', 'disputes/read']],
  ['svc-disputes', [AUTH_VALIDATE, 'users/cards.read', 'transactions/read']],
  ['svc-notifier', ['users/contact.read', 'disputes/read']],
  ['svc-evidence-intake', ['disputes/evidence.write']],
];

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required (defaults live in docker-compose.yml)`);
  return value;
};

const csv = (raw: string): ReadonlyArray<string> =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const defaultBackofficeRedirects = (spaRedirects: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(spaRedirects.map((u) => new URL(u).origin))].flatMap((o) => [`${o}/`, `${o}/agent/callback`]);

const defaultClients = (env: NodeJS.ProcessEnv): ReadonlyArray<Client> => {
  const secret = required(env, 'MOCK_ISSUER_CLIENT_SECRET');
  const spaRedirects = csv(required(env, 'MOCK_ISSUER_SPA_REDIRECT_URIS'));
  const backofficeRedirects = env['MOCK_ISSUER_BACKOFFICE_REDIRECT_URIS']
    ? csv(env['MOCK_ISSUER_BACKOFFICE_REDIRECT_URIS'])
    : defaultBackofficeRedirects(spaRedirects);
  return [
    {
      clientId: SPA_CLIENT_ID,
      secret: null,
      allowedScopes: USER_SCOPES,
      redirectUris: spaRedirects,
      emitsGroups: false,
    },
    {
      clientId: BACKOFFICE_CLIENT_ID,
      secret: null,
      allowedScopes: USER_SCOPES,
      redirectUris: backofficeRedirects,
      emitsGroups: true,
    },
    ...SERVICE_GRANTS.map(([clientId, allowedScopes]) => ({
      clientId,
      secret,
      allowedScopes,
      redirectUris: [],
      emitsGroups: false,
    })),
  ];
};

const parseClients = (raw: string): ReadonlyArray<Client> =>
  (JSON.parse(raw) as ReadonlyArray<Partial<Client> & { clientId: string }>).map((c) => ({
    clientId: c.clientId,
    secret: c.secret ?? null,
    allowedScopes: c.allowedScopes ?? [],
    redirectUris: c.redirectUris ?? [],
    emitsGroups: c.emitsGroups === true,
  }));

export const generateKey = (): KeyObject => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const pem = env['MOCK_ISSUER_PRIVATE_KEY_PEM'];
  const clientsJson = env['MOCK_ISSUER_CLIENTS'];
  const port = Number(env['PORT'] ?? 55900);
  return {
    port,
    issuer: env['MOCK_ISSUER_URL'] ?? `http://localhost:${port}`,
    testHooks: env['MOCK_ISSUER_TEST_HOOKS'] === 'true',
    corsOrigins: csv(env['MOCK_ISSUER_CORS_ORIGINS'] ?? ''),
    privateKey: pem ? createPrivateKey(pem.replaceAll('\\n', '\n')) : generateKey(),
    clients: clientsJson ? parseClients(clientsJson) : defaultClients(env),
  };
};
