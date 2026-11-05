import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres } from '@cd/db/testing';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<
  Role,
  string
>;

export type AuthDb = {
  readonly appPool: pg.Pool;
  readonly seedIdentity: (row: {
    readonly sub: string;
    readonly username: string;
    readonly userId: string;
    readonly status: 'ACTIVE' | 'DISABLED';
  }) => Promise<string>;
  readonly seedAgent: (row: {
    readonly sub: string;
    readonly displayName: string;
    readonly status: 'ACTIVE' | 'DISABLED';
  }) => Promise<string>;
  readonly stop: () => Promise<void>;
};

const ADMIN_SHUTDOWN = '57P01';

const isAdminShutdown = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === ADMIN_SHUTDOWN;

const createTestPool = (connectionString: string): pg.Pool => {
  const pool = new pg.Pool({ connectionString });
  pool.on('error', (err) => {
    if (!isAdminShutdown(err)) throw err;
  });
  return pool;
};

// pool.end() resolves before its clients' sockets close, so wait for every 'remove' before the container stops.
const endPool = async (pool: pg.Pool): Promise<void> => {
  const open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    let left = open;
    if (left === 0) resolve();
    pool.on('remove', () => {
      left -= 1;
      if (left === 0) resolve();
    });
  });
  await pool.end();
  await closed;
};

const roleUrl = (base: string, user: string, password: string): string => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = '/cd';
  return url.toString();
};

// Mirrors Aurora: a non-superuser CREATEROLE master owns the database, then the committed bootstrap and migrations run.
export const startAuthDb = async (): Promise<AuthDb> => {
  const pgc = await startTestPostgres();
  const su = new pg.Client({ connectionString: pgc.connectionString });
  await su.connect();
  await su.query("create role cd_admin login createrole password 'fake-admin-password'");
  await su.query('create database cd owner cd_admin');
  await su.end();
  const adminUrl = roleUrl(pgc.connectionString, 'cd_admin', 'fake-admin-password');
  const booted = await bootstrap({ adminConnectionString: adminUrl, passwords });
  if (!booted.ok) throw new Error(`bootstrap failed: ${booted.error.kind}`);
  const migrated = await migrate({
    schema: 'auth',
    dir: MIGRATIONS_DIR,
    connectionString: roleUrl(adminUrl, 'auth_migrator', passwords.auth_migrator),
  });
  if (!migrated.ok) throw new Error(`migrate failed: ${migrated.error.kind}`);

  const appPool = createTestPool(roleUrl(adminUrl, 'auth_app', passwords.auth_app));
  // auth_app may only read agent_identity; agents are provisioned out of band, as here by the schema owner.
  const operatorPool = createTestPool(roleUrl(adminUrl, 'auth_migrator', passwords.auth_migrator));
  return {
    appPool,
    seedIdentity: async (row) => {
      const { rows } = await appPool.query<{ auth_id: string }>(
        `insert into auth_identity (cognito_sub, username, user_id, status) values ($1, $2, $3, $4) returning auth_id`,
        [row.sub, row.username, row.userId, row.status],
      );
      return rows[0]?.auth_id ?? '';
    },
    seedAgent: async (row) => {
      const { rows } = await operatorPool.query<{ agent_id: string }>(
        `insert into auth.agent_identity (cognito_sub, display_name, status) values ($1, $2, $3) returning agent_id`,
        [row.sub, row.displayName, row.status],
      );
      return rows[0]?.agent_id ?? '';
    },
    stop: async () => {
      await Promise.all([endPool(operatorPool), endPool(appPool)]);
      await pgc.stop();
    },
  };
};
