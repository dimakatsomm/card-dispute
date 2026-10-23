import { fileURLToPath } from 'node:url';
import { ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SEED, generateSeedData } from '../src/generate.ts';
import { runSeed, type SeedOptions } from '../src/seed.ts';

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<Role, string>;
const data = generateSeedData({ seed: DEFAULT_SEED, now: new Date('2026-10-19T09:30:00Z') });

const TABLES = [
  'auth.auth_identity',
  'users.app_user',
  'users.account',
  'users.card',
  'transactions.transaction',
  'disputes.dispute',
  'disputes.dispute_status_history',
] as const;

let pgc: TestPostgres;
let options: SeedOptions;

const adminQuery = async (sql: string): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString: pgc.connectionString });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
};

const rowCounts = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(
      TABLES.map(async (t) => [t, Number((await adminQuery(`select count(*) as n from ${t}`)).rows[0].n)] as const),
    ),
  );

beforeAll(async () => {
  pgc = await startTestPostgres();
  options = {
    adminConnectionString: pgc.connectionString,
    passwords,
    backendDir: fileURLToPath(new URL('../../../backend', import.meta.url)),
    data,
  };
});

afterAll(async () => {
  await pgc?.stop();
});

describe('runSeed against Postgres 18 (bootstrap + committed migrations)', () => {
  it('inserts everything on the first run and changes nothing on the second', async () => {
    const first = await runSeed(options);
    expect(first).toEqual({
      ok: true,
      value: {
        app_user: 4,
        app_user_email_updated: 0,
        account: data.accounts.length,
        card: data.cards.length,
        auth_identity: 4,
        transaction: data.transactions.length,
        dispute: 4,
        dispute_status_history: data.history.length,
      },
    });
    const before = await rowCounts();

    const second = await runSeed(options);
    expect(second.ok && Object.values(second.value).every((n) => n === 0)).toBe(true);
    expect(await rowCounts()).toEqual(before);
  });

  it('keeps every transaction consistent with the users schema (card -> account -> user)', async () => {
    const orphans = await adminQuery(`
      select t.transaction_id from transactions.transaction t
      left join users.card c on c.card_id = t.card_id
      left join users.account a on a.id = c.account_id
      left join users.app_user u on u.id = a.user_id
      where a.account_id is distinct from t.account_id or u.user_id is distinct from t.user_id`);
    expect(orphans.rowCount).toBe(0);
  });

  it('pairs each auth identity with its app_user, and D is DISABLED', async () => {
    const r = await adminQuery(`
      select i.username, i.status, u.status as profile_status from auth.auth_identity i
      join users.app_user u on u.user_id = i.user_id and u.auth_id = i.auth_id order by i.username`);
    expect(r.rows).toEqual([
      { username: 'dumisani.zulu', status: 'DISABLED', profile_status: 'CLOSED' },
      { username: 'lerato.mokoena', status: 'ACTIVE', profile_status: 'ACTIVE' },
      { username: 'sipho.dlamini', status: 'ACTIVE', profile_status: 'ACTIVE' },
      { username: 'thandi.nkosi', status: 'ACTIVE', profile_status: 'ACTIVE' },
    ]);
  });

  it('stores history in action order per dispute', async () => {
    const r = await adminQuery(`
      select d.status, string_agg(h.action, ',' order by h.id) as actions
      from disputes.dispute d join disputes.dispute_status_history h on h.dispute_id = d.id
      group by d.status order by d.status`);
    expect(r.rows).toEqual([
      { status: 'RESOLVED_ACCEPTED', actions: 'CREATE,REVIEW,RESOLVE' },
      { status: 'RESOLVED_REJECTED', actions: 'CREATE,REVIEW,RESOLVE' },
      { status: 'UNDER_REVIEW', actions: 'CREATE,REVIEW' },
      { status: 'WITHDRAWN', actions: 'CREATE,WITHDRAW' },
    ]);
  });
});
