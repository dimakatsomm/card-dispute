import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PERMISSION_DENIED = '42501';
const CHECK_VIOLATION = '23514';

const MIGRATIONS_DIR = fileURLToPath(new URL('..', import.meta.url));

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<
  Role,
  string
>;

let pgc: TestPostgres;
let adminUrl: string;

const urlFor = (base: string, database: string, user: string, password: string): string => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

const roleUrl = (role: Role): string => urlFor(adminUrl, 'cd', role, passwords[role]);

const query = async (connectionString: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result: pg.QueryResult | pg.QueryResult[] = await client.query(sql, params);
    return Array.isArray(result) ? (result.at(-1) as pg.QueryResult) : result;
  } finally {
    await client.end();
  }
};

const USER_ID = '01900000-0000-7000-8000-000000000001';
const ACCOUNT_ID = '01900000-0000-7000-8000-000000000002';
const CARD_ID = '01900000-0000-7000-8000-000000000003';

const fakeId = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

type Row = {
  readonly amount: string;
  readonly currency: string;
  readonly mcc: string | null;
  readonly type: string;
  readonly status: string;
  readonly posted_at: string | null;
};

const validRow: Row = {
  amount: '125.50',
  currency: 'ZAR',
  mcc: '5411',
  type: 'PURCHASE',
  status: 'POSTED',
  posted_at: '2026-10-01T10:00:00Z',
};

const insertAs = (role: Role, row: Row): Promise<pg.QueryResult> =>
  query(
    roleUrl(role),
    `insert into transaction
       (user_id, account_id, card_id, amount, currency, merchant_name, mcc, type, status, transaction_at, posted_at)
     values ($1, $2, $3, $4, $5, 'Fake Grocer', $6, $7, $8, '2026-09-30T10:00:00Z', $9)`,
    [USER_ID, ACCOUNT_ID, CARD_ID, row.amount, row.currency, row.mcc, row.type, row.status, row.posted_at],
  );

beforeAll(async () => {
  pgc = await startTestPostgres();
  // Mirror Aurora: the master is a non-superuser CREATEROLE role that owns the application database.
  await query(pgc.connectionString, "create role cd_admin login createrole password 'fake-admin-password'");
  await query(pgc.connectionString, 'create database cd owner cd_admin');
  adminUrl = urlFor(pgc.connectionString, 'cd', 'cd_admin', 'fake-admin-password');
  expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });
});

afterAll(async () => {
  await pgc?.stop();
});

describe('transactions migrations', () => {
  it('apply from empty as transactions_migrator and are a no-op on re-run', async () => {
    const opts = { schema: 'transactions', dir: MIGRATIONS_DIR, connectionString: roleUrl('transactions_migrator') };
    expect(await migrate(opts)).toEqual({ ok: true, value: { applied: ['001_transaction.sql'] } });
    expect(await migrate(opts)).toEqual({ ok: true, value: { applied: [] } });
  });

  it('let transactions_app insert a valid row', async () => {
    expect((await insertAs('transactions_app', validRow)).rowCount).toBe(1);
  });

  it.each<[string, Partial<Row>]>([
    ['amount 0', { amount: '0' }],
    ['negative amount', { amount: '-1.00' }],
    ['POSTED without posted_at', { status: 'POSTED', posted_at: null }],
    ['unknown status', { status: 'SETTLED' }],
    ['unknown type', { type: 'TRANSFER' }],
    ['lower-case currency', { currency: 'zar' }],
    ['non-digit mcc', { mcc: '54A1' }],
  ])('reject %s', async (_name, patch) => {
    await expect(insertAs('transactions_migrator', { ...validRow, ...patch })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it.each([
    ['UPDATE', `update transaction set status = 'REVERSED'`],
    ['DELETE', 'delete from transaction'],
    ['TRUNCATE', 'truncate transaction'],
  ])('deny transactions_app %s', async (_name, sql) => {
    await expect(query(roleUrl('transactions_app'), sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  describe('GET /transactions pages', () => {
    const users = [100, 101, 102].map(fakeId);
    const accounts = [200, 201, 202, 203, 204, 205].map(fakeId);
    const cards = Array.from({ length: 12 }, (_, i) => fakeId(300 + i));

    // Account k belongs to user k % 3 and card k to account k % 6, so every seeded row is owner-consistent.
    beforeAll(async () => {
      await query(
        roleUrl('transactions_migrator'),
        `insert into transaction
           (user_id, account_id, card_id, amount, currency, merchant_name, type, status, transaction_at)
         select ($1::uuid[])[1 + g % 3], ($2::uuid[])[1 + g % 6], ($3::uuid[])[1 + g % 12],
                1 + g % 500, 'ZAR', 'Fake Merchant ' || g, 'PURCHASE', 'PENDING', now() - g * interval '1 hour'
           from generate_series(1, 600) g`,
        [users, accounts, cards],
      );
      await query(roleUrl('transactions_migrator'), 'analyze transaction');
    });

    it.each([
      ['user-only', `user_id = '${users[0]}'`, 'transaction_user_at_idx'],
      ['user+card', `user_id = '${users[0]}' and card_id = '${cards[0]}'`, 'transaction_user_card_at_idx'],
      ['user+account', `user_id = '${users[0]}' and account_id = '${accounts[0]}'`, 'transaction_user_account_at_idx'],
    ])('serve a %s page from its index', async (_name, where, index) => {
      const plan = await query(
        roleUrl('transactions_app'),
        // Bitmap scans off: at test volume a bitmap scan + sort can win, which would hide whether the index serves the order.
        `set enable_seqscan = off; set enable_bitmapscan = off;
         explain select * from transaction where ${where}
          order by transaction_at desc, transaction_id desc limit 25`,
      );
      const text = plan.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
      expect(text).toContain(`Index Scan using ${index} on transaction`);
      expect(text).not.toContain('Sort');
    });
  });
});
