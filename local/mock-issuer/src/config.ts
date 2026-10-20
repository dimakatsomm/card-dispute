import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type SeedUser = {
  readonly key: 'A' | 'B' | 'C' | 'D';
  readonly sub: string;
  readonly username: string;
  readonly label: string;
};

export type Client = {
  readonly clientId: string;
  readonly secret: string | null;
  readonly allowedScopes: ReadonlyArray<string>;
  readonly redirectUris: ReadonlyArray<string>;
};

export type Config = {
  readonly port: number;
  readonly issuer: string;
  readonly testHooks: boolean;
  readonly corsOrigins: ReadonlyArray<string>;
  readonly privateKey: KeyObject;
  readonly clients: ReadonlyArray<Client>;
};

// D-05 seed data reuses these exact subs.
export const SEED_USERS: ReadonlyArray<SeedUser> = [
  { key: 'A', sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'thandi.nkosi', label: 'Thandi Nkosi' },
  {
    key: 'B',
    sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    username: 'sipho.dlamini',
    label: 'Sipho Dlamini',
  },
  {
    key: 'C',
    sub: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    username: 'lerato.mokoena',
    label: 'Lerato Mokoena',
  },
  {
    key: 'D',
    sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    username: 'dumisani.zulu',
    label: 'Dumisani Zulu (disabled in auth seed)',
  },
];

export const SPA_CLIENT_ID = 'spa';

const AUTH_VALIDATE = 'auth/validate';

// Mirrors the scope grants in docs/05-security.md.
const SERVICE_GRANTS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['svc-users', [AUTH_VALIDATE]],
  ['svc-transactions', [AUTH_VALIDATE, 'users/cards.read', 'disputes/read']],
  ['svc-disputes', [AUTH_VALIDATE, 'users/cards.read', 'transactions/read']],
  ['svc-notifier', ['users/contact.read', 'disputes/read']],
  ['svc-evidence-intake', ['disputes/evidence.write']],
  ['svc-backoffice', ['disputes/review', 'disputes/resolve', 'users/cards.read']],
];

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required (defaults live in docker-compose.yml)`);
  return value;
};

const defaultClients = (env: NodeJS.ProcessEnv): ReadonlyArray<Client> => {
  const secret = required(env, 'MOCK_ISSUER_CLIENT_SECRET');
  const redirects = required(env, 'MOCK_ISSUER_SPA_REDIRECT_URIS')
    .split(',')
    .map((s) => s.trim());
  return [
    {
      clientId: SPA_CLIENT_ID,
      secret: null,
      allowedScopes: ['openid', 'profile', 'email'],
      redirectUris: redirects,
    },
    ...SERVICE_GRANTS.map(([clientId, allowedScopes]) => ({
      clientId,
      secret,
      allowedScopes,
      redirectUris: [],
    })),
  ];
};

const parseClients = (raw: string): ReadonlyArray<Client> =>
  (JSON.parse(raw) as ReadonlyArray<Partial<Client> & { clientId: string }>).map((c) => ({
    clientId: c.clientId,
    secret: c.secret ?? null,
    allowedScopes: c.allowedScopes ?? [],
    redirectUris: c.redirectUris ?? [],
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
    corsOrigins: (env['MOCK_ISSUER_CORS_ORIGINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    privateKey: pem ? createPrivateKey(pem.replaceAll('\\n', '\n')) : generateKey(),
    clients: clientsJson ? parseClients(clientsJson) : defaultClients(env),
  };
};
