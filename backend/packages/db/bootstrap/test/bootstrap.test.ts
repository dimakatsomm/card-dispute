import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '../../src/testing.ts';
import { bootstrap, ROLES, SERVICES, type Role } from '../bootstrap.ts';

const PERMISSION_DENIED = '42501';

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<
  Role,
  string
>;

let pgc: TestPostgres;
let adminUrl: string;
let superUrl: string;

const withDatabase = (base: string, database: string, user?: string, password?: string): string => {
  const url = new URL(base);
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

const query = async (
  connectionString: string,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // A multi-statement query yields one result per statement; callers assert on the last.
    const result: pg.QueryResult | pg.QueryResult[] = await client.query(sql, params);
    return Array.isArray(result) ? (result.at(-1) as pg.QueryResult) : result;
  } finally {
    await client.end();
  }
};

const asRole = (role: Role, sql: string): Promise<pg.QueryResult> =>
  query(withDatabase(adminUrl, 'cd', role, passwords[role]), sql);

const probeObjects = (svc: string): string => `
  create table ${svc}.probe (
    id bigint generated always as identity primary key,
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create trigger probe_updated_at before update on ${svc}.probe for each row execute function ${svc}.set_updated_at();
  insert into ${svc}.probe (note) values ('seed');
  create function ${svc}.probe_fn() returns int language sql as 'select 1';`;

beforeAll(async () => {
  pgc = await startTestPostgres();
  // Mirror Aurora: the master is a non-superuser CREATEROLE role that owns the application database.
  await query(pgc.connectionString, "create role cd_admin login createrole password 'fake-admin-password'");
  await query(pgc.connectionString, 'create database cd owner cd_admin');
  adminUrl = withDatabase(pgc.connectionString, 'cd', 'cd_admin', 'fake-admin-password');
  superUrl = withDatabase(pgc.connectionString, 'cd');

  expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });
  for (const svc of SERVICES) await asRole(`${svc}_migrator`, probeObjects(svc));
});

afterAll(async () => {
  await pgc?.stop();
});

describe('db bootstrap', () => {
  it('re-runs cleanly and leaves schemas owned by their migrators with citext and set_updated_at', async () => {
    expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });

    const schemas = await query(
      adminUrl,
      `select n.nspname as schema, n.nspowner::regrole::text as owner,
              exists (select 1 from pg_proc p where p.pronamespace = n.oid and p.proname = 'set_updated_at') as has_trigger_fn
         from pg_namespace n where n.nspname = any($1) order by 1`,
      [[...SERVICES]],
    );
    expect(schemas.rows).toEqual(
      [...SERVICES].sort().map((s) => ({ schema: s, owner: `${s}_migrator`, has_trigger_fn: true })),
    );
    expect((await query(adminUrl, "select 1 from pg_extension where extname = 'citext'")).rowCount).toBe(1);
  });

  it('pins every role to no superuser, createdb, createrole, replication or bypassrls, even after drift', async () => {
    await query(superUrl, 'alter role users_app createrole');
    expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });

    const roles = await query(
      adminUrl,
      `select rolname, rolcanlogin,
              rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls as elevated
         from pg_roles where rolname = any($1) order by 1`,
      [[...ROLES]],
    );
    expect(roles.rows).toEqual(
      [...ROLES].sort().map((rolname) => ({ rolname, rolcanlogin: true, elevated: false })),
    );
  });

  it('leaves no function in a service schema executable by PUBLIC or SECURITY DEFINER', async () => {
    const offenders = await query(
      adminUrl,
      `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1)
          and (p.prosecdef or p.proacl is null
               or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
      [[...SERVICES]],
    );
    expect(offenders.rows).toEqual([]);
  });

  it('rejects a missing or short password before touching the database', async () => {
    const result = await bootstrap({
      adminConnectionString: adminUrl,
      passwords: { ...passwords, users_app: 'short' },
    });
    expect(result).toEqual({ ok: false, error: { kind: 'invalid-password', role: 'users_app' } });
  });

  it('lets each _app role SELECT and INSERT in its own schema', async () => {
    for (const svc of SERVICES) {
      const r = await asRole(
        `${svc}_app`,
        `insert into probe (note) values ('x'); select count(*)::int as n from probe`,
      );
      expect(r.rows).toEqual([{ n: 2 }]);
    }
  });

  it.each(SERVICES)('%s_app may UPDATE only after its migrator grants it on the table', async (svc) => {
    const app = `${svc}_app` as const;
    await expect(asRole(app, `update probe set note = 'y'`)).rejects.toMatchObject({
      code: PERMISSION_DENIED,
    });
    await asRole(`${svc}_migrator`, `grant update (note) on probe to ${app}`);
    expect((await asRole(app, `update probe set note = 'y'`)).rowCount).toBeGreaterThan(0);
  });

  it.each<[Role, string]>([
    ['users_app', 'transactions'],
    ['disputes_app', 'users'],
    ['transactions_app', 'auth'],
    ['auth_app', 'disputes'],
    ['disputes_retention', 'users'],
    ['users_migrator', 'transactions'],
  ])('%s cannot SELECT from %s', async (role, schema) => {
    await expect(asRole(role, `select * from ${schema}.probe`)).rejects.toMatchObject({
      code: PERMISSION_DENIED,
    });
  });

  it.each<[string, Role, string]>([
    ['users_app cannot DELETE', 'users_app', 'delete from users.probe'],
    ['transactions_app cannot DELETE', 'transactions_app', 'delete from transactions.probe'],
    ['disputes_app cannot DELETE', 'disputes_app', 'delete from disputes.probe'],
    ['auth_app cannot DELETE', 'auth_app', 'delete from auth.probe'],
    ['an _app role cannot CREATE in its schema', 'disputes_app', 'create table disputes.sneaky (id int)'],
    ['an _app role cannot CREATE in public', 'users_app', 'create table public.sneaky (id int)'],
    ['an _app role cannot create temp tables', 'auth_app', 'create temp table sneaky (id int)'],
    [
      'disputes_retention has no default table privileges',
      'disputes_retention',
      'select * from disputes.probe',
    ],
  ])('%s', async (_name, role, sql) => {
    await expect(asRole(role, sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it('set_updated_at bumps updated_at on UPDATE', async () => {
    const r = await asRole(
      'users_migrator',
      `insert into probe (note, updated_at) values ('stale', '2000-01-01');
       update probe set note = 'fresh' where note = 'stale';
       select updated_at > '2000-01-02' as bumped from probe where note = 'fresh'`,
    );
    expect(r.rows).toEqual([{ bumped: true }]);
  });
});
