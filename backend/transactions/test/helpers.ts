import { fileURLToPath } from 'node:url';
import type { Fetch } from '@cd/auth-client';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import { createLogger, type Servers } from '@cd/shared';
import pg from 'pg';
import { configSchema } from '../src/config.ts';
import { compose } from '../src/main.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<Role, string>;

const roleUrl = (base: string, role: Role): string => {
  const url = new URL(base);
  url.username = role;
  url.password = passwords[role];
  url.pathname = '/cd';
  return url.toString();
};

export type TestDb = {
  readonly app: pg.Pool;
  readonly migrator: pg.Pool;
  readonly stop: () => Promise<void>;
};

// Mirrors Aurora: a non-superuser CREATEROLE master owns the database, bootstrap creates the roles, the migrator migrates.
export const startTestDb = async (): Promise<TestDb> => {
  const pgc: TestPostgres = await startTestPostgres();
  const admin = new pg.Client({ connectionString: pgc.connectionString });
  await admin.connect();
  await admin.query("create role cd_admin login createrole password 'fake-admin-password'");
  await admin.query('create database cd owner cd_admin');
  await admin.end();
  const adminUrl = new URL(pgc.connectionString);
  adminUrl.username = 'cd_admin';
  adminUrl.password = 'fake-admin-password';
  adminUrl.pathname = '/cd';
  const boot = await bootstrap({ adminConnectionString: adminUrl.toString(), passwords });
  if (!boot.ok) throw new Error(`bootstrap failed: ${JSON.stringify(boot.error)}`);
  const migrated = await migrate({
    schema: 'transactions',
    dir: MIGRATIONS_DIR,
    connectionString: roleUrl(pgc.connectionString, 'transactions_migrator'),
  });
  if (!migrated.ok) throw new Error(`migrate failed: ${JSON.stringify(migrated.error)}`);
  const app = new pg.Pool({ connectionString: roleUrl(pgc.connectionString, 'transactions_app') });
  const migrator = new pg.Pool({ connectionString: roleUrl(pgc.connectionString, 'transactions_migrator') });
  return {
    app,
    migrator,
    stop: async () => {
      await Promise.all([app.end(), migrator.end()]);
      await pgc.stop();
    },
  };
};

export type SeedRow = {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly amount: string;
  readonly type: 'PURCHASE' | 'REFUND' | 'ATM_WITHDRAWAL' | 'FEE';
  readonly status: 'PENDING' | 'POSTED' | 'DECLINED' | 'REVERSED';
  readonly at: string;
  readonly postedAt: string | null;
};

export const seed = async (pool: pg.Pool, rows: ReadonlyArray<SeedRow>): Promise<void> => {
  for (const r of rows) {
    await pool.query(
      `insert into transaction
         (transaction_id, user_id, account_id, card_id, amount, currency, merchant_name, mcc, type, status, transaction_at, posted_at)
       values ($1, $2, $3, $4, $5, 'ZAR', 'Fake Merchant', '5411', $6, $7, $8, $9)`,
      [r.id, r.userId, r.accountId, r.cardId, r.amount, r.type, r.status, r.at, r.postedAt],
    );
  }
};

export const fakeId = (prefix: number, n: number): string =>
  `0192f0c1-${String(prefix).padStart(4, '0')}-7000-8000-${String(n).padStart(12, '0')}`;

export const AUTH_URL = 'http://auth.test';
export const USERS_URL = 'http://users.test';
export const DISPUTES_URL = 'http://disputes.test';
export const TOKEN_URL = 'http://token.test/oauth2/token';

export type Call = { readonly url: URL; readonly headers: Readonly<Record<string, string>> };

export type Upstream = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Resolves only when the caller aborts, like a peer that accepted the connection and went silent.
export const hang: Upstream = (_call, signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

export type Principals = Readonly<Record<string, unknown>>;

export const userToken = (userId: string) => ({
  valid: true,
  principalType: 'user',
  authId: `auth-${userId}`,
  userId,
  scopes: [],
  exp: 4_000_000_000,
});

export const serviceToken = (scopes: ReadonlyArray<string>) => ({
  valid: true,
  principalType: 'service',
  clientId: 'svc-disputes',
  scopes,
  exp: 4_000_000_000,
});

export type Harness = {
  readonly servers: Servers;
  readonly calls: Call[];
  readonly clock: { now: number };
};

export const buildHarness = (
  pool: pg.Pool,
  principals: Principals,
  upstream: { readonly users: Upstream; readonly disputes: Upstream; readonly auth?: (call: Call) => Response | undefined },
): Harness => {
  const calls: Call[] = [];
  const clock = { now: 1_800_000_000_000 };
  const fetch: Fetch = async (input, init) => {
    const call: Call = {
      url: new URL(String(input)),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    const signal = init?.signal ?? undefined;
    if (call.url.href === TOKEN_URL) return json(200, { access_token: 'svc-transactions-token', expires_in: 3600 });
    if (call.url.origin === AUTH_URL) {
      const override = upstream.auth?.(call);
      if (override) return override;
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      return json(200, principals[token] ?? { valid: false, reason: 'bad_signature' });
    }
    if (call.url.origin === USERS_URL) return upstream.users(call, signal);
    if (call.url.origin === DISPUTES_URL) return upstream.disputes(call, signal);
    throw new Error(`unexpected outbound call ${call.url.href}`);
  };
  const config = configSchema.parse({
    DATABASE_URL: 'unused-pool-is-injected',
    AUTH_URL,
    USERS_SERVICE_URL: USERS_URL,
    DISPUTES_SERVICE_URL: DISPUTES_URL,
    TOKEN_URL,
    SERVICE_CLIENT_ID: 'svc-transactions',
    SERVICE_CLIENT_SECRET: 'fake-client-secret',
  });
  const servers = compose({
    config,
    pool,
    fetch,
    nowMs: () => clock.now,
    logger: createLogger({ level: 'silent' }),
  });
  return { servers, calls, clock };
};

export const outboundTo = (calls: ReadonlyArray<Call>, origin: string): ReadonlyArray<Call> =>
  calls.filter((c) => c.url.origin === origin);
