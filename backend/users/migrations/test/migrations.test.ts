import { fileURLToPath } from 'node:url';
import { migrate, type MigrateResult } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PERMISSION_DENIED = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

const MIGRATIONS_DIR = fileURLToPath(new URL('..', import.meta.url));

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<
  Role,
  string
>;

let pgc: TestPostgres;
let adminUrl: string;
let migrated: MigrateResult;

const roleUrl = (role: Role): string => {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = passwords[role];
  return url.toString();
};

const query = async (connectionString: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
};

const asRole = (role: Role, sql: string, params: unknown[] = []): Promise<pg.QueryResult> =>
  query(roleUrl(role), sql, params);

type CardRow = {
  readonly token: string;
  readonly last4: string;
  readonly expiry_month: number;
  readonly expiry_year: number;
  readonly status: string;
};

const validCard = (token: string): CardRow => ({
  token,
  last4: '4821',
  expiry_month: 12,
  expiry_year: 2030,
  status: 'ACTIVE',
});

const insertCard = (role: Role, card: CardRow): Promise<pg.QueryResult> =>
  asRole(
    role,
    `insert into card (account_id, token, last4, expiry_month, expiry_year, brand, card_type, status)
     values ((select id from account limit 1), $1, $2, $3, $4, 'VISA', 'DEBIT', $5)`,
    [card.token, card.last4, card.expiry_month, card.expiry_year, card.status],
  );

const insertUser = (role: Role, email: string, cellphone: string | null): Promise<pg.QueryResult> =>
  asRole(
    role,
    `insert into app_user (auth_id, name, surname, cellphone_number, email)
     values (gen_random_uuid(), 'Testy', 'McFake', $1, $2)`,
    [cellphone, email],
  );

beforeAll(async () => {
  pgc = await startTestPostgres();
  // Mirror Aurora: the master is a non-superuser CREATEROLE role that owns the application database.
  await query(pgc.connectionString, "create role cd_admin login createrole password 'fake-admin-password'");
  await query(pgc.connectionString, 'create database cd owner cd_admin');
  const url = new URL(pgc.connectionString);
  url.username = 'cd_admin';
  url.password = 'fake-admin-password';
  url.pathname = '/cd';
  adminUrl = url.toString();

  expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });
  migrated = await migrate({ connectionString: roleUrl('users_migrator'), schema: 'users', dir: MIGRATIONS_DIR });

  await insertUser('users_migrator', 'seed.user@example.com', '+27820000001');
  await asRole(
    'users_migrator',
    `insert into account (user_id, account_number_masked, account_type, currency)
     values ((select id from app_user limit 1), '****4821', 'CHEQUE', 'ZAR')`,
  );
  await insertCard('users_migrator', validCard('tok_seed_0001'));
});

afterAll(async () => {
  await pgc?.stop();
});

describe('users migrations', () => {
  it('apply from empty via migrate() as users_migrator, with the expected tables', async () => {
    expect(migrated).toEqual({ ok: true, value: { applied: ['001_users_accounts_cards.sql'] } });

    const tables = await asRole(
      'users_migrator',
      `select table_name from information_schema.tables
        where table_schema = 'users' and table_name <> 'schema_migrations' order by 1`,
    );
    expect(tables.rows.map((r: { table_name: string }) => r.table_name)).toEqual(['account', 'app_user', 'card']);
  });

  it.each<[string, () => Promise<pg.QueryResult>, string]>([
    ['cellphone not E.164', () => insertUser('users_app', 'a@example.com', '0821234567'), CHECK_VIOLATION],
    ['email duplicate ignoring case', () => insertUser('users_app', 'SEED.User@example.com', null), UNIQUE_VIOLATION],
    ['last4 not digits', () => insertCard('users_app', { ...validCard('tok_a'), last4: 'abcd' }), CHECK_VIOLATION],
    ['duplicate card token', () => insertCard('users_app', validCard('tok_seed_0001')), UNIQUE_VIOLATION],
    ['card status EXPIRED', () => insertCard('users_app', { ...validCard('tok_b'), status: 'EXPIRED' }), CHECK_VIOLATION],
    ['expiry_month 13', () => insertCard('users_app', { ...validCard('tok_c'), expiry_month: 13 }), CHECK_VIOLATION],
    ['expiry_year 2101', () => insertCard('users_app', { ...validCard('tok_d'), expiry_year: 2101 }), CHECK_VIOLATION],
    [
      'unmasked account number',
      () =>
        asRole(
          'users_app',
          `insert into account (user_id, account_number_masked, account_type, currency)
           values ((select id from app_user limit 1), '62001234821', 'CHEQUE', 'ZAR')`,
        ),
      CHECK_VIOLATION,
    ],
  ])('rejects %s', async (_name, write, code) => {
    await expect(write()).rejects.toMatchObject({ code });
  });

  it('refuses to delete an account that still has cards (ON DELETE RESTRICT)', async () => {
    await expect(asRole('users_migrator', 'delete from account')).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it.each<[string, Role, string]>([
    ['users_app cannot DELETE a card', 'users_app', 'delete from card'],
    ['users_app cannot DELETE a user', 'users_app', 'delete from app_user'],
    ['users_app cannot DELETE an account', 'users_app', 'delete from account'],
    ['users_app cannot UPDATE app_user.auth_id', 'users_app', 'update app_user set auth_id = auth_id'],
    ['users_app cannot UPDATE account.account_id', 'users_app', 'update account set account_id = account_id'],
    ['users_app cannot UPDATE card.card_id', 'users_app', 'update card set card_id = card_id'],
    ['users_app cannot UPDATE card.account_id', 'users_app', 'update card set account_id = account_id'],
    ['users_app cannot UPDATE card.expiry_month', 'users_app', 'update card set expiry_month = 1'],
    ['users_app cannot UPDATE card.token', 'users_app', "update card set token = 'tok_swapped'"],
    ['users_app cannot UPDATE card.last4', 'users_app', "update card set last4 = '0000'"],
    ['users_app cannot UPDATE app_user.user_id', 'users_app', 'update app_user set user_id = gen_random_uuid()'],
    ['users_app cannot UPDATE account.user_id', 'users_app', 'update account set user_id = user_id'],
    ['transactions_app cannot SELECT users.card', 'transactions_app', 'select * from users.card'],
  ])('%s', async (_name, role, sql) => {
    await expect(asRole(role, sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  // Self-assignment still needs the column privilege and keeps rows stable for the other tests.
  it.each<[string, string]>([
    ['app_user', 'name'],
    ['app_user', 'surname'],
    ['app_user', 'cellphone_number'],
    ['app_user', 'email'],
    ['app_user', 'status'],
    ['account', 'status'],
    ['card', 'status'],
  ])('users_app can UPDATE %s.%s', async (table, column) => {
    expect((await asRole('users_app', `update ${table} set ${column} = ${column}`)).rowCount).toBeGreaterThan(0);
  });

  it('lets users_app change card status and bumps updated_at', async () => {
    const r = await asRole(
      'users_app',
      `update card set status = 'BLOCKED' where token = 'tok_seed_0001'
       returning updated_at > created_at as bumped`,
    );
    expect(r.rows).toEqual([{ bumped: true }]);
  });
});
