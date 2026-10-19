import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PERMISSION_DENIED = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';

const MIGRATIONS_DIR = fileURLToPath(new URL('..', import.meta.url));
const SHA = 'a'.repeat(64);
const DESCRIPTION = 'Card was charged twice';

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<Role, string>;

let pgc: TestPostgres;
let adminUrl: string;

const urlFor = (role: Role): string => {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = passwords[role];
  return url.toString();
};

const query = async (connectionString: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
};

const asRole = (role: Role, sql: string, params: unknown[] = []): Promise<pg.QueryResult> =>
  query(urlFor(role), sql, params);

const migrateAsMigrator = () =>
  migrate({ schema: 'disputes', dir: MIGRATIONS_DIR, connectionString: urlFor('disputes_migrator') });

type DisputeSeed = { readonly status?: string; readonly resolvedAt?: string | null; readonly transactionId?: string };

const insertDispute = async ({
  status = 'SUBMITTED',
  resolvedAt = null,
  transactionId = randomUUID(),
}: DisputeSeed = {}): Promise<{ id: string; transactionId: string }> => {
  const r = await asRole(
    'disputes_app',
    `insert into dispute (transaction_id, user_id, reason_code, description, status, resolved_at, created_by, updated_by)
     values ($1, $2, 'DUPLICATE', $3, $4, $5, 'USER:u', 'USER:u') returning id`,
    [transactionId, randomUUID(), DESCRIPTION, status, resolvedAt],
  );
  return { id: r.rows[0].id as string, transactionId };
};

const insertEvidence = async (disputeId: string, status: 'PENDING' | 'STORED' | 'REJECTED' = 'STORED'): Promise<string> => {
  const r = await asRole(
    'disputes_app',
    `insert into dispute_evidence
       (dispute_id, file_name, declared_content_type, declared_size_bytes, declared_sha256, status, s3_key, rejection_reason)
     values ($1, 'receipt.pdf', 'application/pdf', 100, $2, $3::text,
             case when $3 = 'STORED' then 'evidence/x/y' end, case when $3 = 'REJECTED' then 'MALWARE' end)
     returning id`,
    [disputeId, SHA, status],
  );
  return r.rows[0].id as string;
};

const freshDispute = async (): Promise<{ id: string; evidenceId: string }> => {
  const { id } = await insertDispute();
  await asRole(
    'disputes_app',
    `insert into dispute_status_history (dispute_id, action, to_status, actor_type, actor_id, note, after)
     values ($1, 'CREATE', 'SUBMITTED', 'USER', 'u', 'raised', '{"reasonCode":"DUPLICATE"}')`,
    [id],
  );
  return { id, evidenceId: await insertEvidence(id) };
};

const eraseEvidence = (evidenceId: string): Promise<pg.QueryResult> =>
  asRole(
    'disputes_retention',
    `update disputes.dispute_evidence set status = 'ERASED' where id = $1 returning s3_key, rejection_reason`,
    [evidenceId],
  );

beforeAll(async () => {
  pgc = await startTestPostgres();
  await query(pgc.connectionString, "create role cd_admin login createrole password 'fake-admin-password'");
  await query(pgc.connectionString, 'create database cd owner cd_admin');
  const url = new URL(pgc.connectionString);
  url.username = 'cd_admin';
  url.password = 'fake-admin-password';
  url.pathname = '/cd';
  adminUrl = url.toString();

  expect(await bootstrap({ adminConnectionString: adminUrl, passwords })).toMatchObject({ ok: true });
  expect(await migrateAsMigrator()).toEqual({
    ok: true,
    value: { applied: ['001_dispute.sql', '002_dispute_status_history.sql', '003_dispute_evidence.sql'] },
  });
});

afterAll(async () => {
  await pgc?.stop();
});

describe('disputes migrations', () => {
  it('re-running migrate as disputes_migrator applies nothing', async () => {
    expect(await migrateAsMigrator()).toEqual({ ok: true, value: { applied: [] } });
  });

  it.each<[string, string | null]>([
    ['SUBMITTED', null],
    ['UNDER_REVIEW', null],
    ['WITHDRAWN', null],
    ['RESOLVED_ACCEPTED', '2026-10-01T00:00:00Z'],
    ['RESOLVED_REJECTED', '2026-10-01T00:00:00Z'],
  ])('a second dispute for a transaction whose dispute is %s is rejected', async (status, resolvedAt) => {
    const first = await insertDispute({ status, resolvedAt });
    await expect(insertDispute({ transactionId: first.transactionId })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('description length counts code points, not bytes', async () => {
    const r = await asRole(
      'disputes_app',
      `insert into dispute (transaction_id, user_id, reason_code, description, status, created_by, updated_by)
       values ($1, $2, 'OTHER', $3, 'SUBMITTED', 'USER:u', 'USER:u') returning char_length(description) as n`,
      [randomUUID(), randomUUID(), 'é'.repeat(10)],
    );
    expect(r.rows).toEqual([{ n: 10 }]);
  });

  const insertDisputeSql = (reason: string, description: string, status: string, resolvedAt = 'null'): string =>
    `insert into dispute (transaction_id, user_id, reason_code, description, status, resolved_at, created_by, updated_by)
     values (gen_random_uuid(), gen_random_uuid(), '${reason}', ${description}, '${status}', ${resolvedAt}, 'USER:u', 'USER:u')`;

  const insertEvidenceSql = (d: string, status: string, extra: { s3Key?: string; reason?: string; size?: number } = {}) =>
    `insert into dispute_evidence
       (dispute_id, file_name, declared_content_type, declared_size_bytes, declared_sha256, status, s3_key, rejection_reason)
     values (${d}, 'a.pdf', 'application/pdf', ${extra.size ?? 1}, '${SHA}', '${status}',
             ${extra.s3Key ? `'${extra.s3Key}'` : 'null'}, ${extra.reason ? `'${extra.reason}'` : 'null'})`;

  it.each<[string, (disputeId: string) => string]>([
    ['description of 9 chars', () => insertDisputeSql('OTHER', `'123456789'`, 'SUBMITTED')],
    ['description of 2001 chars', () => insertDisputeSql('OTHER', `repeat('x', 2001)`, 'SUBMITTED')],
    ['unknown reason code', () => insertDisputeSql('CHARGEBACK', `'${DESCRIPTION}'`, 'SUBMITTED')],
    ['unknown dispute status', () => insertDisputeSql('OTHER', `'${DESCRIPTION}'`, 'REOPENED')],
    ['resolved_at without a RESOLVED_* status', () => insertDisputeSql('OTHER', `'${DESCRIPTION}'`, 'WITHDRAWN', 'now()')],
    ['RESOLVED_* status without resolved_at', () => insertDisputeSql('OTHER', `'${DESCRIPTION}'`, 'RESOLVED_ACCEPTED')],
    [
      'unknown history action',
      (d) => `insert into dispute_status_history (dispute_id, action, from_status, to_status, actor_type, actor_id)
              values (${d}, 'REOPEN', 'WITHDRAWN', 'SUBMITTED', 'USER', 'u')`,
    ],
    [
      'unknown history actor type',
      (d) => `insert into dispute_status_history (dispute_id, action, to_status, actor_type, actor_id)
              values (${d}, 'CREATE', 'SUBMITTED', 'ADMIN', 'u')`,
    ],
    ['rejection_reason on a non-REJECTED evidence row', (d) => insertEvidenceSql(d, 'PENDING', { reason: 'MALWARE' })],
    ['s3_key on a non-STORED evidence row', (d) => insertEvidenceSql(d, 'PENDING', { s3Key: 'evidence/x/y' })],
    ['s3_key outside evidence/', (d) => insertEvidenceSql(d, 'STORED', { s3Key: 'quarantine/x/y' })],
    ['unknown evidence status', (d) => insertEvidenceSql(d, 'SCANNING')],
    ['evidence over 10 MiB', (d) => insertEvidenceSql(d, 'PENDING', { size: 10485761 })],
  ])('CHECK rejects %s', async (_name, sql) => {
    const { id } = await insertDispute();
    await expect(asRole('disputes_app', sql(id))).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('disputes_app can apply a status change through its granted columns and updated_at is bumped', async () => {
    const { id } = await insertDispute();
    const r = await asRole(
      'disputes_app',
      `update dispute set status = 'RESOLVED_ACCEPTED', resolved_at = now(), resolution_note = 'refunded',
              version = version + 1, updated_by = 'AGENT:a1'
        where id = $1 returning version, updated_at > created_at as bumped`,
      [id],
    );
    expect(r.rows).toEqual([{ version: 2, bumped: true }]);
  });

  it.each<[string, string]>([
    ['UPDATE dispute_status_history', `update dispute_status_history set note = 'rewritten'`],
    ['DELETE dispute', 'delete from dispute'],
    ['DELETE dispute_status_history', 'delete from dispute_status_history'],
    ['DELETE dispute_evidence', 'delete from dispute_evidence'],
    ['TRUNCATE dispute_status_history', 'truncate dispute_status_history'],
    ['UPDATE dispute.transaction_id', 'update dispute set transaction_id = gen_random_uuid()'],
    ['UPDATE dispute.user_id', 'update dispute set user_id = gen_random_uuid()'],
    ['UPDATE dispute.created_by', `update dispute set created_by = 'USER:x'`],
    ['UPDATE dispute.updated_at', 'update dispute set updated_at = now()'],
    ['UPDATE dispute_evidence.declared_sha256', `update dispute_evidence set declared_sha256 = '${'b'.repeat(64)}'`],
    ['UPDATE dispute_evidence.updated_at', 'update dispute_evidence set updated_at = now()'],
  ])('disputes_app is denied %s', async (_name, sql) => {
    await expect(asRole('disputes_app', sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it('disputes_app cannot erase evidence', async () => {
    const { evidenceId } = await freshDispute();
    await expect(
      asRole('disputes_app', `update dispute_evidence set status = 'ERASED', s3_key = null where id = $1`, [evidenceId]),
    ).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it('disputes_retention can scrub history note/before/after and dispute text fields', async () => {
    const { id } = await freshDispute();
    const history = await asRole(
      'disputes_retention',
      `update disputes.dispute_status_history set note = '[erased]', before = null, after = null where dispute_id = $1`,
      [id],
    );
    expect(history.rowCount).toBe(1);
    const dispute = await asRole(
      'disputes_retention',
      `update disputes.dispute set description = '[erased]', resolution_note = '[erased]' where id = $1`,
      [id],
    );
    expect(dispute.rowCount).toBe(1);
  });

  it.each(['STORED', 'REJECTED'] as const)('disputes_retention erasing a %s evidence row clears s3_key and rejection_reason', async (status) => {
    const { id } = await insertDispute();
    const evidenceId = await insertEvidence(id, status);
    expect((await eraseEvidence(evidenceId)).rows).toEqual([{ s3_key: null, rejection_reason: null }]);
  });

  it.each<Role>(['disputes_app', 'disputes_retention'])('%s cannot revive ERASED evidence', async (role) => {
    const { evidenceId } = await freshDispute();
    await eraseEvidence(evidenceId);
    await expect(
      asRole(role, `update disputes.dispute_evidence set status = 'PENDING' where id = $1`, [evidenceId]),
    ).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it.each<[string, string]>([
    ['UPDATE history.to_status', `update disputes.dispute_status_history set to_status = 'WITHDRAWN'`],
    ['UPDATE history.actor_id', `update disputes.dispute_status_history set actor_id = 'x'`],
    ['UPDATE dispute.status', `update disputes.dispute set status = 'WITHDRAWN'`],
    ['UPDATE evidence.s3_key', 'update disputes.dispute_evidence set s3_key = null'],
    ['DELETE dispute', 'delete from disputes.dispute'],
    ['DELETE dispute_status_history', 'delete from disputes.dispute_status_history'],
    ['DELETE dispute_evidence', 'delete from disputes.dispute_evidence'],
    [
      'INSERT dispute_status_history',
      `insert into disputes.dispute_status_history (dispute_id, action, to_status, actor_type, actor_id)
       values (1, 'CREATE', 'SUBMITTED', 'USER', 'u')`,
    ],
  ])('disputes_retention is denied %s', async (_name, sql) => {
    await expect(asRole('disputes_retention', sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it.each<[string, string]>([
    ['UPDATE', `update dispute_status_history set note = 'rewritten' where dispute_id = $1`],
    ['DELETE', 'delete from dispute_status_history where dispute_id = $1'],
  ])('history stays insert-only even for its owner: %s', async (_name, sql) => {
    const { id } = await freshDispute();
    await expect(asRole('disputes_migrator', sql, [id])).rejects.toMatchObject({
      code: PERMISSION_DENIED,
      message: expect.stringContaining('insert-only'),
    });
  });

  it('history cannot be truncated even by its owner', async () => {
    await expect(asRole('disputes_migrator', 'truncate dispute_status_history')).rejects.toMatchObject({
      code: PERMISSION_DENIED,
      message: expect.stringContaining('insert-only'),
    });
  });

  it('history guard triggers exist and are enabled', async () => {
    const r = await asRole(
      'disputes_migrator',
      `select tgname, tgenabled from pg_trigger
        where tgrelid = 'disputes.dispute_status_history'::regclass and not tgisinternal order by tgname`,
    );
    expect(r.rows).toEqual([
      { tgname: 'dispute_status_history_immutable', tgenabled: 'O' },
      { tgname: 'dispute_status_history_no_truncate', tgenabled: 'O' },
    ]);
  });

  it('a dispute with history and evidence cannot be deleted even by its owner (FK RESTRICT)', async () => {
    const { id } = await freshDispute();
    await expect(asRole('disputes_migrator', 'delete from dispute where id = $1', [id])).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
  });

  it('adds no SECURITY DEFINER or PUBLIC-executable function', async () => {
    const r = await query(
      adminUrl,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'disputes'
          and (p.prosecdef or p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
    );
    expect(r.rows).toEqual([]);
  });
});
