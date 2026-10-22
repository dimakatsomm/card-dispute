import { join } from 'node:path';
import { migrate, withTransaction, type MigrateError } from '@cd/db';
import { bootstrap, SERVICES, type BootstrapError, type Role } from '@cd/db/bootstrap';
import { err, ok, type Result } from '@cd/shared/fp';
import pg from 'pg';
import type { SeedData } from './generate.ts';

export type Service = (typeof SERVICES)[number];
export type UrlFor = (svc: Service) => string;

export type SeedOptions = {
  readonly adminConnectionString: string;
  readonly passwords: Readonly<Record<Role, string>>;
  readonly backendDir: string;
  readonly data: SeedData;
};

export type InsertedCounts = Readonly<Record<string, number>>;

export type SeedError =
  | { readonly kind: 'bootstrap'; readonly error: BootstrapError }
  | { readonly kind: 'migrate'; readonly schema: Service; readonly error: MigrateError }
  | { readonly kind: 'insert'; readonly schema: Service; readonly message: string };

const roleUrl = (adminUrl: string, role: Role, password: string): string => {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
};

const SQL = {
  appUser: `
    insert into users.app_user (user_id, auth_id, name, surname, cellphone_number, email, status)
    select user_id, auth_id, name, surname, cellphone_number, email, status
    from jsonb_to_recordset($1::jsonb) as r(user_id uuid, auth_id uuid, name text, surname text,
      cellphone_number text, email text, status text)
    on conflict do nothing`,
  account: `
    insert into users.account (account_id, user_id, account_number_masked, account_type, currency)
    select r.account_id, u.id, r.account_number_masked, r.account_type, r.currency
    from jsonb_to_recordset($1::jsonb) as r(account_id uuid, user_id uuid, account_number_masked text,
      account_type text, currency text)
    join users.app_user u on u.user_id = r.user_id
    on conflict do nothing`,
  card: `
    insert into users.card (card_id, account_id, token, last4, expiry_month, expiry_year, brand, card_type)
    select r.card_id, a.id, r.token, r.last4, r.expiry_month, r.expiry_year, r.brand, r.card_type
    from jsonb_to_recordset($1::jsonb) as r(card_id uuid, account_id uuid, token text, last4 text,
      expiry_month smallint, expiry_year smallint, brand text, card_type text)
    join users.account a on a.account_id = r.account_id
    on conflict do nothing`,
  authIdentity: `
    insert into auth.auth_identity (auth_id, cognito_sub, username, user_id, status)
    select auth_id, cognito_sub, username, user_id, status
    from jsonb_to_recordset($1::jsonb) as r(auth_id uuid, cognito_sub text, username text, user_id uuid, status text)
    on conflict do nothing`,
  // A skipped insert must not hide a stale row: the stored identity has to be the one the provider issued.
  identityMismatch: `
    select r.username from jsonb_to_recordset($1::jsonb) as r(cognito_sub text, username text, user_id uuid)
    left join auth.auth_identity i on i.username = r.username
    where i.cognito_sub is distinct from r.cognito_sub or i.user_id is distinct from r.user_id`,
  transaction: `
    insert into transactions.transaction (transaction_id, user_id, account_id, card_id, amount, currency,
      merchant_name, mcc, type, status, transaction_at, posted_at)
    select transaction_id, user_id, account_id, card_id, amount, currency, merchant_name, mcc, type, status,
      transaction_at, posted_at
    from jsonb_to_recordset($1::jsonb) as r(transaction_id uuid, user_id uuid, account_id uuid, card_id uuid,
      amount numeric(12, 2), currency text, merchant_name text, mcc text, type text, status text,
      transaction_at timestamptz, posted_at timestamptz)
    on conflict do nothing`,
  dispute: `
    insert into disputes.dispute (dispute_id, transaction_id, user_id, reason_code, description, status, version,
      resolved_at, resolution_note, created_by, updated_by, created_at, updated_at)
    select dispute_id, transaction_id, user_id, reason_code, description, status, version, resolved_at,
      resolution_note, created_by, updated_by, created_at, updated_at
    from jsonb_to_recordset($1::jsonb) as r(dispute_id uuid, transaction_id uuid, user_id uuid, reason_code text,
      description text, status text, version int, resolved_at timestamptz, resolution_note text, created_by text,
      updated_by text, created_at timestamptz, updated_at timestamptz)
    on conflict do nothing
    returning dispute_id`,
  // History has no natural key, so it is written only alongside a dispute inserted in this same transaction.
  history: `
    insert into disputes.dispute_status_history (dispute_id, action, from_status, to_status, actor_type, actor_id,
      note, after, created_at)
    select d.id, h.action, h.from_status, h.to_status, h.actor_type, h.actor_id, h.note, h.after, h.created_at
    from jsonb_to_recordset($1::jsonb) as h(dispute_id uuid, seq int, action text, from_status text, to_status text,
      actor_type text, actor_id text, note text, after jsonb, created_at timestamptz)
    join disputes.dispute d on d.dispute_id = h.dispute_id
    where h.dispute_id = any($2::uuid[])
    order by h.dispute_id, h.seq`,
} as const;

type Insert = (client: pg.PoolClient) => Promise<InsertedCounts>;

const count = async (client: pg.PoolClient, sql: string, params: ReadonlyArray<unknown>): Promise<number> =>
  (await client.query(sql, [...params])).rowCount ?? 0;

const json = (rows: ReadonlyArray<unknown>): string => JSON.stringify(rows);

const inserts = (data: SeedData): Readonly<Record<Service, Insert>> => ({
  // docs/03 provisioning order: app_user is written before auth_identity.
  users: async (c) => ({
    app_user: await count(c, SQL.appUser, [json(data.appUsers)]),
    account: await count(c, SQL.account, [json(data.accounts)]),
    card: await count(c, SQL.card, [json(data.cards)]),
  }),
  auth: async (c) => {
    const inserted = await count(c, SQL.authIdentity, [json(data.authIdentities)]);
    const mismatched = await c.query<{ username: string }>(SQL.identityMismatch, [json(data.authIdentities)]);
    if (mismatched.rows.length > 0) {
      throw new Error(`auth_identity differs from the identity provider for ${mismatched.rows.map((r) => r.username).join(', ')}`);
    }
    return { auth_identity: inserted };
  },
  transactions: async (c) => ({ transaction: await count(c, SQL.transaction, [json(data.transactions)]) }),
  disputes: async (c) => {
    const created = await c.query<{ dispute_id: string }>(SQL.dispute, [json(data.disputes)]);
    const ids = created.rows.map((row) => row.dispute_id);
    return {
      dispute: ids.length,
      dispute_status_history: await count(c, SQL.history, [json(data.history), ids]),
    };
  },
});

const SEED_ORDER: ReadonlyArray<Service> = ['users', 'auth', 'transactions', 'disputes'];

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const withPool = async <T>(connectionString: string, fn: (pool: pg.Pool) => Promise<T>): Promise<T> => {
  const pool = new pg.Pool({ connectionString, max: 1 });
  pool.on('error', () => undefined);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
};

const migrateAll = async (options: SeedOptions, urlFor: UrlFor): Promise<Result<true, SeedError>> => {
  for (const schema of SERVICES) {
    const result = await migrate({ schema, dir: join(options.backendDir, schema, 'migrations'), connectionString: urlFor(schema) });
    if (!result.ok) return err({ kind: 'migrate', schema, error: result.error });
  }
  return ok(true);
};

export const insertAll = async (data: SeedData, urlFor: UrlFor): Promise<Result<InsertedCounts, SeedError>> => {
  const plan = inserts(data);
  return SEED_ORDER.reduce<Promise<Result<InsertedCounts, SeedError>>>(async (pending, schema) => {
    const previous = await pending;
    if (!previous.ok) return previous;
    try {
      // Each schema's owner role writes its own rows; the admin login never touches service data.
      const counts = await withPool(urlFor(schema), (pool) => withTransaction(pool, plan[schema]));
      return ok({ ...previous.value, ...counts });
    } catch (e) {
      return err({ kind: 'insert', schema, message: messageOf(e) });
    }
  }, Promise.resolve(ok({})));
};

export const runSeed = async (options: SeedOptions): Promise<Result<InsertedCounts, SeedError>> => {
  const boot = await bootstrap({ adminConnectionString: options.adminConnectionString, passwords: options.passwords });
  if (!boot.ok) return err({ kind: 'bootstrap', error: boot.error });
  const urlFor: UrlFor = (svc) =>
    roleUrl(options.adminConnectionString, `${svc}_migrator`, options.passwords[`${svc}_migrator`]);
  const migrated = await migrateAll(options, urlFor);
  return migrated.ok ? insertAll(options.data, urlFor) : migrated;
};
