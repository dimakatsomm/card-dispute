import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@cd/shared/fp';
import pg from 'pg';
import { withTransaction } from './transaction.ts';

export type MigrateOptions = {
  readonly schema: string;
  readonly dir: string;
} & ({ readonly connectionString: string } | { readonly pool: pg.Pool });

export type MigrateError =
  | { readonly kind: 'invalid-schema'; readonly schema: string }
  | { readonly kind: 'invalid-filename'; readonly file: string }
  | { readonly kind: 'duplicate-version'; readonly version: string }
  | { readonly kind: 'migrations-unreadable'; readonly dir: string; readonly message: string }
  | { readonly kind: 'migration-failed'; readonly file: string; readonly message: string };

export type MigrateResult = Result<{ readonly applied: ReadonlyArray<string> }, MigrateError>;

type Migration = { readonly file: string; readonly sql: string };

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const FILE_RE = /^(\d+)_[a-z0-9_]+\.sql$/;

const versionOf = (file: string): number => Number(FILE_RE.exec(file)?.[1]);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const listMigrations = async (dir: string): Promise<Result<ReadonlyArray<string>, MigrateError>> => {
  const entries = await readdir(dir).then(
    (names) => ok(names.filter((f) => f.endsWith('.sql'))),
    (e: unknown) => err<MigrateError>({ kind: 'migrations-unreadable', dir, message: messageOf(e) }),
  );
  if (!entries.ok) return entries;
  const files = entries.value;
  const badName = files.find((f) => !FILE_RE.test(f));
  if (badName !== undefined) return err({ kind: 'invalid-filename', file: badName });
  const versions = files.map(versionOf);
  if (new Set(versions).size !== versions.length) {
    const dup = versions.find((v, i) => versions.indexOf(v) !== i);
    return err({ kind: 'duplicate-version', version: String(dup) });
  }
  return ok([...files].sort((a, b) => versionOf(a) - versionOf(b)));
};

const loadMigrations = async (dir: string): Promise<Result<ReadonlyArray<Migration>, MigrateError>> => {
  const files = await listMigrations(dir);
  if (!files.ok) return files;
  return Promise.all(files.value.map(async (file) => ({ file, sql: await readFile(join(dir, file), 'utf8') }))).then(
    (migrations) => ok(migrations),
    (e: unknown) => err<MigrateError>({ kind: 'migrations-unreadable', dir, message: messageOf(e) }),
  );
};

const applyOne = async (pool: pg.Pool, schema: string, { file, sql }: Migration): Promise<boolean> =>
  withTransaction(pool, async (client) => {
    // Serialises concurrent runners (e.g. several task replicas starting at once) per schema.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`migrate:${schema}`]);
    await client.query(
      `create table if not exists "${schema}".schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
    );
    const done = await client.query(`select 1 from "${schema}".schema_migrations where name = $1`, [file]);
    if (done.rowCount) return false;
    // Unqualified object names in a migration land in the service's own schema.
    await client.query(`set local search_path to "${schema}"`);
    await client.query(sql);
    await client.query(`insert into "${schema}".schema_migrations (name) values ($1)`, [file]);
    return true;
  });

// Recursion keeps `applied` immutable and stops at the first failure.
const applyAll = async (
  pool: pg.Pool,
  schema: string,
  pending: ReadonlyArray<Migration>,
  applied: ReadonlyArray<string>,
): Promise<MigrateResult> => {
  const [head, ...rest] = pending;
  if (head === undefined) return ok({ applied });
  const outcome = await applyOne(pool, schema, head).then(
    (did) => ok(did),
    (e: unknown) => err<MigrateError>({ kind: 'migration-failed', file: head.file, message: messageOf(e) }),
  );
  if (!outcome.ok) return outcome;
  return applyAll(pool, schema, rest, outcome.value ? [...applied, head.file] : applied);
};

const withPool = async <T>(options: MigrateOptions, fn: (pool: pg.Pool) => Promise<T>): Promise<T> => {
  if ('pool' in options) return fn(options.pool);
  const pool = new pg.Pool({ connectionString: options.connectionString });
  // An idle-client error would otherwise crash the process; the next query surfaces real failures.
  pool.on('error', () => undefined);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
};

export const migrate = async (options: MigrateOptions): Promise<MigrateResult> => {
  const { schema, dir } = options;
  if (!SCHEMA_RE.test(schema)) return err({ kind: 'invalid-schema', schema });

  const migrations = await loadMigrations(dir);
  if (!migrations.ok) return migrations;

  return withPool(options, (pool) => applyAll(pool, schema, migrations.value, []));
};
