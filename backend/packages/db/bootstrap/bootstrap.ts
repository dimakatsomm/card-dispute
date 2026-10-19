import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { err, ok, type Result } from '@cd/shared/fp';
import { withTransaction } from '../src/transaction.ts';
import { scramVerifier } from './scram.ts';

export const SERVICES = ['auth', 'users', 'transactions', 'disputes'] as const;

export const ROLES = [
  ...SERVICES.flatMap((svc) => [`${svc}_migrator`, `${svc}_app`] as const),
  'disputes_retention',
] as const;

export type Role = (typeof ROLES)[number];

export type BootstrapOptions = {
  readonly adminConnectionString: string;
  readonly passwords: Readonly<Record<Role, string>>;
};

export type BootstrapError =
  | { readonly kind: 'invalid-password'; readonly role: Role }
  | { readonly kind: 'sql-unreadable'; readonly message: string }
  | { readonly kind: 'bootstrap-failed'; readonly message: string };

const MIN_PASSWORD_LENGTH = 16;
// Printable ASCII only: SASLprep is then the identity, so the client-side verifier matches what the server derives.
const PASSWORD_RE = /^[\x20-\x7e]+$/;

const SQL_FILE = new URL('./bootstrap.sql', import.meta.url);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const invalidRole = (passwords: BootstrapOptions['passwords']): Role | undefined =>
  ROLES.find((role) => {
    const pw = passwords[role];
    return typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH || !PASSWORD_RE.test(pw);
  });

const readSql = async (): Promise<Result<string, BootstrapError>> => {
  try {
    return ok(await readFile(SQL_FILE, 'utf8'));
  } catch (e) {
    return err({ kind: 'sql-unreadable', message: messageOf(e) });
  }
};

const run = async (
  options: BootstrapOptions,
  sql: string,
): Promise<Result<readonly Role[], BootstrapError>> => {
  const pool = new pg.Pool({ connectionString: options.adminConnectionString, max: 1 });
  try {
    await withTransaction(pool, async (client) => {
      for (const role of ROLES) {
        await client.query('select set_config($1, $2, true)', [
          `cd_bootstrap.verifier_${role}`,
          scramVerifier(options.passwords[role]),
        ]);
      }
      await client.query(sql);
    });
    return ok(ROLES);
  } catch (e) {
    // Only the message: pg's `where` field would echo the failing statement.
    return err({ kind: 'bootstrap-failed', message: messageOf(e) });
  } finally {
    await pool.end();
  }
};

export const bootstrap = async (
  options: BootstrapOptions,
): Promise<Result<readonly Role[], BootstrapError>> => {
  const bad = invalidRole(options.passwords);
  if (bad) return err({ kind: 'invalid-password', role: bad });
  const sql = await readSql();
  return sql.ok ? run(options, sql.value) : sql;
};
