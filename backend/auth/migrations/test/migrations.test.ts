import { fileURLToPath } from 'node:url';
import { migrate, type MigrateResult } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PERMISSION_DENIED = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const MIGRATIONS_DIR = fileURLToPath(new URL('..', import.meta.url));

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<
  Role,
  string
>;

const SEEDED_USER_ID = '01990000-0000-7000-8000-000000000001';

let pgc: TestPostgres;
let adminUrl: string;
let firstRun: MigrateResult;

const urlFor = (base: string, user: string, password: string): string => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = '/cd';
  return url.toString();
};

const roleUrl = (role: Role): string => urlFor(adminUrl, role, passwords[role]);

const asRole = async (role: Role, sql: string, params: unknown[] = []): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString: roleUrl(role) });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
};

const insertIdentity = (
  role: Role,
  row: { sub: string; username: string; userId?: string; status?: string },
): Promise<pg.QueryResult> =>
  asRole(
    role,
    `insert into auth_identity (cognito_sub, username, user_id, status)
     values ($1, $2, coalesce($3::uuid, uuidv7()), coalesce($4, 'ACTIVE')) returning auth_id`,
    [row.sub, row.username, row.userId ?? null, row.status ?? null],
  );

const migrateAsMigrator = (): Promise<MigrateResult> =>
  migrate({ schema: 'auth', dir: MIGRATIONS_DIR, connectionString: roleUrl('auth_migrator') });

beforeAll(async () => {
  pgc = await startTestPostgres();
  const su = new pg.Client({ connectionString: pgc.connectionString });
  await su.connect();
  // Mirror Aurora: the master is a non-superuser CREATEROLE role that owns the application database.
  await su.query("create role cd_admin login createrole password 'fake-admin-password'");
  await su.query('create database cd owner cd_admin');
  await su.end();
  adminUrl = urlFor(pgc.connectionString, 'cd_admin', 'fake-admin-password');
  expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });
  firstRun = await migrateAsMigrator();
  await insertIdentity('auth_app', { sub: 'sub-dup', username: 'taken', userId: SEEDED_USER_ID });
});

afterAll(async () => {
  await pgc?.stop();
});

describe('auth migrations', () => {
  it('apply cleanly from empty as auth_migrator and are idempotent on re-run', async () => {
    expect(firstRun).toEqual({ ok: true, value: { applied: ['001_auth_identity.sql'] } });
    expect(await migrateAsMigrator()).toEqual({ ok: true, value: { applied: [] } });
  });

  it.each<[string, { sub: string; username: string; userId?: string; status?: string }, string]>([
    ['duplicate cognito_sub', { sub: 'sub-dup', username: 'other-a' }, UNIQUE_VIOLATION],
    ['duplicate username', { sub: 'sub-other-b', username: 'taken' }, UNIQUE_VIOLATION],
    [
      'duplicate user_id',
      { sub: 'sub-other-c', username: 'other-c', userId: SEEDED_USER_ID },
      UNIQUE_VIOLATION,
    ],
    ['unknown status', { sub: 'sub-bad-status', username: 'bad-status', status: 'LOCKED' }, CHECK_VIOLATION],
    ['mixed-case username', { sub: 'sub-upper', username: 'Mixed.Case' }, CHECK_VIOLATION],
    ['empty cognito_sub', { sub: '', username: 'empty-sub' }, CHECK_VIOLATION],
  ])('rejects %s', async (_name, row, code) => {
    await expect(insertIdentity('auth_app', row)).rejects.toMatchObject({ code });
  });

  it('lets auth_app SELECT, INSERT and flip status, which bumps updated_at', async () => {
    const { rows } = await insertIdentity('auth_app', { sub: 'sub-offboard', username: 'offboard' });
    const authId = (rows[0] as { auth_id: string }).auth_id;
    await asRole('auth_migrator', `update auth_identity set updated_at = '2000-01-01' where auth_id = $1`, [authId]);

    await asRole('auth_app', `update auth_identity set status = 'DISABLED' where auth_id = $1`, [authId]);

    const after = await asRole(
      'auth_app',
      `select status, updated_at > '2000-01-02' as bumped from auth_identity where auth_id = $1`,
      [authId],
    );
    expect(after.rows).toEqual([{ status: 'DISABLED', bumped: true }]);
  });

  it.each([
    ['UPDATE user_id', `update auth_identity set user_id = uuidv7()`],
    ['UPDATE cognito_sub', `update auth_identity set cognito_sub = 'hijack'`],
    ['UPDATE username', `update auth_identity set username = 'hijack'`],
    ['DELETE', `delete from auth_identity`],
  ])('denies auth_app %s', async (_name, sql) => {
    await expect(asRole('auth_app', sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });
});
