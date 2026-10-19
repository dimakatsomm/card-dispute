import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, withTransaction } from '../src/index.ts';
import { startTestPostgres, type TestPostgres } from '../src/testing.ts';

let pgc: TestPostgres;
let pool: pg.Pool;
const dirs: string[] = [];

const makeDir = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'cd-db-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
};

beforeAll(async () => {
  pgc = await startTestPostgres();
  pool = new pg.Pool({ connectionString: pgc.connectionString });
  await pool.query('create schema svc_a; create schema svc_b; create schema svc_c; create schema svc_d');
  await pool.query('create table public.t (id int primary key)');
});

afterAll(async () => {
  await pool?.end();
  await pgc?.stop();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('migrate', () => {
  it('applies files in numeric order, records them, and re-run is a no-op', async () => {
    const dir = await makeDir({
      '002_add_row.sql': "insert into items values (1, 'x');",
      '001_create.sql': 'create table items (id int primary key, v text);',
    });
    const first = await migrate({ connectionString: pgc.connectionString, schema: 'svc_a', dir });
    expect(first).toEqual({ ok: true, value: { applied: ['001_create.sql', '002_add_row.sql'] } });

    const second = await migrate({ pool, schema: 'svc_a', dir });
    expect(second).toEqual({ ok: true, value: { applied: [] } });

    const rec = await pool.query('select name from svc_a.schema_migrations order by name');
    expect(rec.rows.map((r) => r.name)).toEqual(['001_create.sql', '002_add_row.sql']);
    const rows = await pool.query('select count(*)::int as n from svc_a.items');
    expect(rows.rows[0].n).toBe(1);
  });

  it('does not leak its search_path to later connections', async () => {
    const dir = await makeDir({ '001_create.sql': 'create table items (id int);' });
    const single = new pg.Pool({ connectionString: pgc.connectionString, max: 1 });
    try {
      expect((await migrate({ pool: single, schema: 'svc_b', dir })).ok).toBe(true);
      const sp = await single.query('show search_path');
      expect(sp.rows[0].search_path).toBe('"$user", public');
      const r = await single.query("select to_regclass('svc_b.items') as b, to_regclass('public.items') as p");
      expect(r.rows[0]).toEqual({ b: 'svc_b.items', p: null });
    } finally {
      await single.end();
    }
  });

  it('applies each file exactly once when two runners race', async () => {
    const dir = await makeDir({
      '001_create.sql': 'create table items (id int);',
      '002_more.sql': 'alter table items add column v text;',
    });
    const [a, b] = await Promise.all([
      migrate({ connectionString: pgc.connectionString, schema: 'svc_d', dir }),
      migrate({ connectionString: pgc.connectionString, schema: 'svc_d', dir }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const applied = [a, b].flatMap((r) => (r.ok ? r.value.applied : []));
    expect([...applied].sort()).toEqual(['001_create.sql', '002_more.sql']);
    const rec = await pool.query('select name from svc_d.schema_migrations order by name');
    expect(rec.rows.map((r) => r.name)).toEqual(['001_create.sql', '002_more.sql']);
  });

  it('rolls back a failing migration and does not record it', async () => {
    const dir = await makeDir({
      '001_ok.sql': 'create table good (id int);',
      '002_bad.sql': 'create table half (id int); select 1/0;',
    });
    const result = await migrate({ pool, schema: 'svc_c', dir });
    expect(result).toMatchObject({ ok: false, error: { kind: 'migration-failed', file: '002_bad.sql' } });

    const rec = await pool.query('select name from svc_c.schema_migrations');
    expect(rec.rows.map((r) => r.name)).toEqual(['001_ok.sql']);
    const r = await pool.query("select to_regclass('svc_c.half') as half");
    expect(r.rows[0].half).toBeNull();
  });

  it('rejects bad filenames and schema names without touching the database', async () => {
    const dir = await makeDir({ 'bad.sql': 'select 1;' });
    expect(await migrate({ pool, schema: 'svc_a', dir })).toEqual({
      ok: false,
      error: { kind: 'invalid-filename', file: 'bad.sql' },
    });
    expect(await migrate({ pool, schema: 'x"; drop schema svc_a', dir })).toMatchObject({
      ok: false,
      error: { kind: 'invalid-schema' },
    });
  });

  it('rejects duplicate versions', async () => {
    const dir = await makeDir({ '001_a.sql': 'select 1;', '1_b.sql': 'select 1;' });
    expect(await migrate({ pool, schema: 'svc_a', dir })).toEqual({
      ok: false,
      error: { kind: 'duplicate-version', version: '1' },
    });
  });

  it('returns an error value for an unreadable migrations dir', async () => {
    const dir = join(tmpdir(), 'cd-db-does-not-exist');
    expect(await migrate({ pool, schema: 'svc_a', dir })).toMatchObject({
      ok: false,
      error: { kind: 'migrations-unreadable', dir },
    });
  });
});

describe('withTransaction', () => {
  it('commits on success', async () => {
    const value = await withTransaction(pool, async (c) => {
      await c.query('insert into public.t values (1)');
      return 'done';
    });
    expect(value).toBe('done');
    expect((await pool.query('select id from public.t')).rows).toEqual([{ id: 1 }]);
  });

  it('rolls back and rethrows on error', async () => {
    await expect(
      withTransaction(pool, async (c) => {
        await c.query('insert into public.t values (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await pool.query('select id from public.t where id = 2')).rows).toEqual([]);
  });
});
