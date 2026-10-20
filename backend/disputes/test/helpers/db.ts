import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { MIGRATIONS_DIR } from '../../src/main.ts';

export type TestDb = {
  readonly appPool: pg.Pool;
  readonly count: (
    table: 'dispute' | 'dispute_status_history' | 'dispute_evidence',
    transactionId: string,
  ) => Promise<number>;
  readonly appQuery: (sql: string, params?: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;
  readonly stop: () => Promise<void>;
};

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<
  Role,
  string
>;

const runAs = async (connectionString: string, sql: string): Promise<void> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

const COUNT_SQL = {
  dispute: 'select count(*)::int as n from dispute where transaction_id = $1',
  dispute_status_history:
    'select count(*)::int as n from dispute_status_history h join dispute d on d.id = h.dispute_id where d.transaction_id = $1',
  dispute_evidence:
    'select count(*)::int as n from dispute_evidence e join dispute d on d.id = e.dispute_id where d.transaction_id = $1',
} as const;

// Same path as production: bootstrap roles, apply the committed migrations as disputes_migrator, run as disputes_app.
export const startDisputesDb = async (): Promise<TestDb> => {
  const container = await startTestPostgres();
  await runAs(
    container.connectionString,
    "create role cd_admin login createrole password 'fake-admin-password'",
  );
  await runAs(container.connectionString, 'create database cd owner cd_admin');
  const admin = new URL(container.connectionString);
  admin.username = 'cd_admin';
  admin.password = 'fake-admin-password';
  admin.pathname = '/cd';
  const urlFor = (role: Role): string => {
    const url = new URL(admin.toString());
    url.username = role;
    url.password = passwords[role];
    return url.toString();
  };

  const booted = await bootstrap({ adminConnectionString: admin.toString(), passwords });
  if (!booted.ok) throw new Error(`bootstrap failed: ${JSON.stringify(booted.error)}`);
  const migrated = await migrate({
    schema: 'disputes',
    dir: MIGRATIONS_DIR,
    connectionString: urlFor('disputes_migrator'),
  });
  if (!migrated.ok) throw new Error(`migrate failed: ${JSON.stringify(migrated.error)}`);

  const appPool = new pg.Pool({ connectionString: urlFor('disputes_app'), max: 20 });
  const appQuery = (sql: string, params: ReadonlyArray<unknown> = []) => appPool.query(sql, [...params]);
  return {
    appPool,
    appQuery,
    count: async (table, transactionId) => {
      const res = await appQuery(COUNT_SQL[table], [transactionId]);
      return (res.rows[0] as { n: number }).n;
    },
    stop: async () => {
      await appPool.end();
      await container.stop();
    },
  };
};
