import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres } from '@cd/db/testing';
import pg from 'pg';

export type TestDb = {
  readonly appPool: pg.Pool;
  readonly seedPool: pg.Pool;
  readonly stop: () => Promise<void>;
};

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<Role, string>;

const asAdmin = async (connectionString: string, sql: string): Promise<void> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

const withUser = (base: string, user: string, password: string): string => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
};

export const startUsersDb = async (): Promise<TestDb> => {
  const container = await startTestPostgres();
  // Mirror Aurora: the master is a non-superuser CREATEROLE role that owns the application database.
  await asAdmin(container.connectionString, "create role cd_admin login createrole password 'fake-admin-password'");
  await asAdmin(container.connectionString, 'create database cd owner cd_admin');
  const dbUrl = new URL(container.connectionString);
  dbUrl.pathname = '/cd';
  const adminUrl = withUser(dbUrl.toString(), 'cd_admin', 'fake-admin-password');

  const booted = await bootstrap({ adminConnectionString: adminUrl, passwords });
  if (!booted.ok) throw new Error(`bootstrap failed: ${booted.error.kind}`);
  const migratorUrl = withUser(adminUrl, 'users_migrator', passwords.users_migrator);
  const migrated = await migrate({ connectionString: migratorUrl, schema: 'users', dir: MIGRATIONS_DIR });
  if (!migrated.ok) throw new Error(`migrate failed: ${migrated.error.kind}`);

  const appPool = new pg.Pool({ connectionString: withUser(adminUrl, 'users_app', passwords.users_app) });
  const seedPool = new pg.Pool({ connectionString: migratorUrl });
  return {
    appPool,
    seedPool,
    stop: async () => {
      await Promise.all([appPool.end(), seedPool.end()]);
      await container.stop();
    },
  };
};

export type SeedCard = {
  readonly token: string;
  readonly last4: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
};

export type SeededAccount = { readonly accountId: string; readonly cardIds: ReadonlyArray<string> };

export type SeededUser = {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly accounts: ReadonlyArray<SeededAccount>;
};

export const seedUser = async (
  pool: pg.Pool,
  user: { readonly name: string; readonly email: string; readonly accounts: ReadonlyArray<ReadonlyArray<SeedCard>> },
): Promise<SeededUser> => {
  const u = await pool.query<{ id: string; user_id: string }>(
    `insert into app_user (auth_id, name, surname, cellphone_number, email)
     values (gen_random_uuid(), $1, 'Testcase', '+27820000001', $2) returning id, user_id`,
    [user.name, user.email],
  );
  const owner = u.rows[0];
  if (!owner) throw new Error('user insert returned no row');

  const accounts: SeededAccount[] = [];
  for (const [i, cards] of user.accounts.entries()) {
    const a = await pool.query<{ id: string; account_id: string }>(
      `insert into account (user_id, account_number_masked, account_type, currency)
       values ($1, $2, 'CHEQUE', 'ZAR') returning id, account_id`,
      [owner.id, `****${String(1000 + i)}`],
    );
    const account = a.rows[0];
    if (!account) throw new Error('account insert returned no row');
    const cardIds: string[] = [];
    for (const card of cards) {
      const c = await pool.query<{ card_id: string }>(
        `insert into card (account_id, token, last4, expiry_month, expiry_year, brand, card_type)
         values ($1, $2, $3, $4, $5, 'VISA', 'DEBIT') returning card_id`,
        [account.id, card.token, card.last4, card.expiryMonth, card.expiryYear],
      );
      cardIds.push(c.rows[0]?.card_id ?? '');
    }
    accounts.push({ accountId: account.account_id, cardIds });
  }
  return { userId: owner.user_id, email: user.email, name: user.name, accounts };
};
