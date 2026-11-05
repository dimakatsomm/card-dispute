import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import { createLogger } from '@cd/shared/lambda';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ERASURE_CANDIDATES_SQL,
  EXPIRE_PENDING_SQL,
  type RetentionPool,
} from '../src/adapters/retention-store.ts';
import { composeHandler, type EvidenceInput } from '../src/main.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../disputes/migrations', import.meta.url));
const TEMPLATE_DB = 'sweeper_tpl';
const SHA = 'a'.repeat(64);
const DESCRIPTION = 'Card was charged twice at the till';
const RESOLUTION_NOTE = 'Refunded to the card in full';
const FILE_NAME = 'receipt-jane-doe.pdf';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const T = new Date('2025-03-10T12:00:00.000Z');
const T_PLUS_1Y = new Date('2026-03-10T12:00:00.000Z');

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0001`])) as Record<Role, string>;

let pgc: TestPostgres;
let dbCounter = 0;
let openPools: pg.Pool[] = [];

const withDatabase = (connectionString: string, database: string, role?: Role): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  if (role !== undefined) {
    url.username = role;
    url.password = passwords[role];
  }
  return url.toString();
};

const superQuery = async (sql: string, database = 'postgres'): Promise<void> => {
  const client = new pg.Client({ connectionString: withDatabase(pgc.connectionString, database) });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

type Db = { readonly pool: (role: Role) => pg.Pool };

// A fresh copy of the migrated template per test: the sweeper scans globally, so tests must not share rows.
const freshDb = async (): Promise<Db> => {
  dbCounter += 1;
  const name = `sweeper_${dbCounter}`;
  await superQuery(`create database ${name} template ${TEMPLATE_DB}`);
  return {
    pool: (role) => {
      const pool = new pg.Pool({ connectionString: withDatabase(pgc.connectionString, name, role), max: 2 });
      openPools = [...openPools, pool];
      return pool;
    },
  };
};

beforeAll(async () => {
  pgc = await startTestPostgres();
  await superQuery("create role cd_admin login createrole password 'fake-admin-password'");
  await superQuery(`create database ${TEMPLATE_DB} owner cd_admin`);
  const adminUrl = new URL(withDatabase(pgc.connectionString, TEMPLATE_DB));
  adminUrl.username = 'cd_admin';
  adminUrl.password = 'fake-admin-password';
  expect(await bootstrap({ adminConnectionString: adminUrl.toString(), passwords })).toMatchObject({ ok: true });
  expect(
    await migrate({
      schema: 'disputes',
      dir: MIGRATIONS_DIR,
      connectionString: withDatabase(pgc.connectionString, TEMPLATE_DB, 'disputes_migrator'),
    }),
  ).toMatchObject({ ok: true, value: { applied: expect.arrayContaining(['004_retention_erasure.sql']) } });
});

afterEach(async () => {
  await Promise.all(openPools.map((p) => p.end()));
  openPools = [];
});

afterAll(async () => {
  await pgc?.stop();
});

type Seeded = { readonly id: string; readonly disputeId: string };

const insertDispute = async (
  owner: pg.Pool,
  status: string,
  createdAt: Date,
  resolvedAt: Date | null,
  disputeId: string = randomUUID(),
): Promise<Seeded> => {
  const r = await owner.query<{ id: string; dispute_id: string }>(
    `insert into disputes.dispute (dispute_id, transaction_id, user_id, reason_code, description, status, resolved_at,
                                   resolution_note, created_by, updated_by, created_at, updated_at)
     values ($8, $1, $2, 'DUPLICATE', $3, $4, $5, $6, 'USER:u', 'AGENT:a', $7, $7) returning id, dispute_id`,
    [randomUUID(), randomUUID(), DESCRIPTION, status, resolvedAt, resolvedAt ? RESOLUTION_NOTE : null, createdAt, disputeId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('seed failed');
  return { id: row.id, disputeId: row.dispute_id };
};

const insertHistory = (
  owner: pg.Pool,
  id: string,
  action: string,
  from: string | null,
  to: string,
  at: Date,
): Promise<unknown> =>
  owner.query(
    `insert into disputes.dispute_status_history
       (dispute_id, action, from_status, to_status, actor_type, actor_id, note, before, after, created_at)
     values ($1, $2, $3, $4, 'USER', 'u', 'note with customer words', $5, $6, $7)`,
    [id, action, from, to, from ? { status: from } : null, { status: to, description: DESCRIPTION }, at],
  );

const insertEvidence = (
  owner: pg.Pool,
  id: string,
  status: 'PENDING' | 'STORED' | 'REJECTED',
  createdAt: Date,
): Promise<unknown> =>
  owner.query(
    `insert into disputes.dispute_evidence (dispute_id, file_name, declared_content_type, declared_size_bytes,
                                            declared_sha256, status, s3_key, rejection_reason, created_at, updated_at)
     values ($1, $2, 'application/pdf', 100, $3, $4::text,
             case when $4 = 'STORED' then 'evidence/' || gen_random_uuid() end,
             case when $4 = 'REJECTED' then 'MALWARE' end, $5, $5)`,
    [id, FILE_NAME, SHA, status, createdAt],
  );

const seedTerminal = async (
  owner: pg.Pool,
  status: 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'WITHDRAWN',
  terminalAt: Date,
  disputeId?: string,
): Promise<Seeded> => {
  const createdAt = new Date(terminalAt.getTime() - 7 * DAY);
  const resolved = status !== 'WITHDRAWN';
  const d = await insertDispute(owner, status, createdAt, resolved ? terminalAt : null, disputeId);
  await insertHistory(owner, d.id, 'CREATE', null, 'SUBMITTED', createdAt);
  await (resolved
    ? insertHistory(owner, d.id, 'RESOLVE', 'UNDER_REVIEW', status, terminalAt)
    : insertHistory(owner, d.id, 'WITHDRAW', 'SUBMITTED', 'WITHDRAWN', terminalAt));
  await insertEvidence(owner, d.id, 'STORED', createdAt);
  await insertEvidence(owner, d.id, 'REJECTED', createdAt);
  return d;
};

type Snapshot = {
  readonly dispute: Record<string, unknown>;
  readonly history: ReadonlyArray<Record<string, unknown>>;
  readonly evidence: ReadonlyArray<Record<string, unknown>>;
};

const snapshot = async (owner: pg.Pool, id: string): Promise<Snapshot> => {
  const rows = async (sql: string) => (await owner.query<{ j: Record<string, unknown> }>(sql, [id])).rows.map((r) => r.j);
  const [dispute] = await rows('select to_jsonb(d) as j from disputes.dispute d where id = $1');
  return {
    dispute: dispute ?? {},
    history: await rows('select to_jsonb(h) as j from disputes.dispute_status_history h where dispute_id = $1 order by id'),
    evidence: await rows('select to_jsonb(e) as j from disputes.dispute_evidence e where dispute_id = $1 order by id'),
  };
};

const expectErased = (before: Snapshot, after: Snapshot): void => {
  expect(after.dispute).toEqual({ ...before.dispute, description: '[erased]', resolution_note: null });
  expect(after.history).toEqual(before.history.map((h) => ({ ...h, note: null, before: null, after: null })));
  expect(after.evidence).toEqual(
    before.evidence.map((e) => ({
      ...e,
      status: 'ERASED',
      file_name: '[erased]',
      s3_key: null,
      rejection_reason: null,
      updated_at: expect.any(String),
    })),
  );
};

const evidenceStatuses = async (owner: pg.Pool): Promise<string[]> =>
  (await owner.query<{ status: string }>('select status from disputes.dispute_evidence order by id')).rows.map(
    (r) => r.status,
  );

// Fails on the evidence statement, after the dispute and history updates in the same transaction succeeded.
const failingEvidenceErase = (pool: pg.Pool, victimId: string): RetentionPool => ({
  query: pool.query.bind(pool) as pg.Pool['query'],
  connect: (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get: (target, prop, receiver) =>
        prop === 'query'
          ? (sql: string, params?: unknown[]) =>
              sql.includes('disputes.dispute_evidence') && params?.[0] === victimId
                ? Promise.reject(Object.assign(new Error('injected'), { code: 'XX000' }))
                : target.query(sql, params)
          : Reflect.get(target, prop, receiver),
    });
  }) as pg.Pool['connect'],
});

type HandlerOptions = {
  readonly now: Date;
  readonly batchSize?: number;
  readonly lines?: string[];
  readonly evidence?: EvidenceInput;
};

const sweeper = (pool: RetentionPool, { now, batchSize = 100, lines = [], evidence }: HandlerOptions) =>
  composeHandler({
    pool,
    ...(evidence === undefined ? {} : { evidence }),
    batchSize,
    namespace: 'cd/retention-sweeper',
    now: () => now,
    log: createLogger({ destination: { write: (line: string) => lines.push(line) } }),
  });

describe('retention-sweeper against the real disputes migrations', () => {
  it('fails fast and changes nothing when not connected as disputes_retention', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const d = await seedTerminal(owner, 'RESOLVED_ACCEPTED', T);
    await insertEvidence(owner, d.id, 'PENDING', T);
    const before = await snapshot(owner, d.id);

    await expect(sweeper(db.pool('disputes_app'), { now: T_PLUS_1Y })()).rejects.toThrow(
      'must connect as disputes_retention, not disputes_app',
    );
    expect(await snapshot(owner, d.id)).toEqual(before);
  });

  it('expires PENDING evidence at or beyond 24 h (status only), leaves younger PENDING and STORED; a second run changes 0', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const now = new Date('2026-06-01T08:00:00.000Z');
    const d = await insertDispute(owner, 'SUBMITTED', new Date(now.getTime() - 3 * DAY), null);
    await insertEvidence(owner, d.id, 'PENDING', new Date(now.getTime() - 24 * HOUR));
    await insertEvidence(owner, d.id, 'PENDING', new Date(now.getTime() - 24 * HOUR + 1));
    await insertEvidence(owner, d.id, 'STORED', new Date(now.getTime() - 3 * DAY));
    const before = await snapshot(owner, d.id);
    const handler = sweeper(db.pool('disputes_retention'), { now });

    expect(await handler()).toEqual({ expired: 1, erased: 0, evidenceVersionsDeleted: 0 });
    const after = await snapshot(owner, d.id);
    expect(after.evidence).toEqual([
      { ...before.evidence[0], status: 'EXPIRED', updated_at: expect.any(String) },
      before.evidence[1],
      before.evidence[2],
    ]);
    expect(after.dispute).toEqual(before.dispute);

    expect(await handler()).toEqual({ expired: 0, erased: 0, evidenceVersionsDeleted: 0 });
    expect(await snapshot(owner, d.id)).toEqual(after);
  });

  it.each(['RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'WITHDRAWN'] as const)(
    'clock proof: a %s dispute terminal at T is untouched at T+1y-1ms and fully erased at T+1y',
    async (status) => {
      const db = await freshDb();
      const owner = db.pool('disputes_migrator');
      const retention = db.pool('disputes_retention');
      const d = await seedTerminal(owner, status, T);
      const before = await snapshot(owner, d.id);

      expect(await sweeper(retention, { now: new Date(T_PLUS_1Y.getTime() - 1) })()).toEqual({ expired: 0, erased: 0, evidenceVersionsDeleted: 0 });
      expect(await snapshot(owner, d.id)).toEqual(before);

      expect(await sweeper(retention, { now: T_PLUS_1Y })()).toEqual({ expired: 0, erased: 1, evidenceVersionsDeleted: 0 });
      expectErased(before, await snapshot(owner, d.id));
    },
  );

  it('never erases SUBMITTED or UNDER_REVIEW disputes, however old', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const old = new Date('2020-01-01T00:00:00.000Z');
    const submitted = await insertDispute(owner, 'SUBMITTED', old, null);
    await insertHistory(owner, submitted.id, 'CREATE', null, 'SUBMITTED', old);
    await insertEvidence(owner, submitted.id, 'STORED', old);
    const underReview = await insertDispute(owner, 'UNDER_REVIEW', old, null);
    await insertHistory(owner, underReview.id, 'CREATE', null, 'SUBMITTED', old);
    await insertHistory(owner, underReview.id, 'REVIEW', 'SUBMITTED', 'UNDER_REVIEW', old);
    const before = [await snapshot(owner, submitted.id), await snapshot(owner, underReview.id)];

    expect(await sweeper(db.pool('disputes_retention'), { now: new Date('2030-01-01T00:00:00.000Z') })()).toEqual({
      expired: 0,
      erased: 0,
      evidenceVersionsDeleted: 0,
    });
    expect([await snapshot(owner, submitted.id), await snapshot(owner, underReview.id)]).toEqual(before);
  });

  it('a forced failure mid-dispute leaves that dispute wholly unerased, still erases the others and fails the run', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const victim = await seedTerminal(owner, 'RESOLVED_REJECTED', T);
    const other = await seedTerminal(owner, 'WITHDRAWN', new Date(T.getTime() + HOUR));
    const before = { victim: await snapshot(owner, victim.id), other: await snapshot(owner, other.id) };
    const now = new Date(T_PLUS_1Y.getTime() + DAY);

    const lines: string[] = [];

    await expect(sweeper(failingEvidenceErase(retention, victim.id), { now, lines })()).rejects.toThrow('failed to erase 1 dispute(s)');
    expect(await snapshot(owner, victim.id)).toEqual(before.victim);
    expectErased(before.other, await snapshot(owner, other.id));
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ disputeId: victim.disputeId, sqlState: 'XX000', msg: 'dispute erasure failed' }),
    );

    expect(await sweeper(retention, { now })()).toEqual({ expired: 0, erased: 1, evidenceVersionsDeleted: 0 });
    expectErased(before.victim, await snapshot(owner, victim.id));
  });

  it('a second run changes 0', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const resolved = await seedTerminal(owner, 'RESOLVED_ACCEPTED', T);
    const withdrawn = await seedTerminal(owner, 'WITHDRAWN', T);
    await insertEvidence(owner, resolved.id, 'PENDING', T);

    expect(await sweeper(retention, { now: T_PLUS_1Y })()).toEqual({ expired: 1, erased: 2, evidenceVersionsDeleted: 0 });
    const after = [await snapshot(owner, resolved.id), await snapshot(owner, withdrawn.id)];

    expect(await sweeper(retention, { now: T_PLUS_1Y })()).toEqual({ expired: 0, erased: 0, evidenceVersionsDeleted: 0 });
    expect([await snapshot(owner, resolved.id), await snapshot(owner, withdrawn.id)]).toEqual(after);
  });

  it('batch cap: cap+1 eligible gives cap, then 1 on the next run, oldest first', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const oldest = await seedTerminal(owner, 'WITHDRAWN', new Date(T.getTime() - 2 * DAY));
    await seedTerminal(owner, 'RESOLVED_ACCEPTED', new Date(T.getTime() - DAY));
    const newest = await seedTerminal(owner, 'RESOLVED_REJECTED', T);
    const holder = await insertDispute(owner, 'SUBMITTED', T, null);
    await Promise.all([0, 1, 2].map((i) => insertEvidence(owner, holder.id, 'PENDING', new Date(T.getTime() - i * HOUR))));
    const handler = sweeper(retention, { now: T_PLUS_1Y, batchSize: 2 });
    const isErased = async (id: string) => (await snapshot(owner, id)).dispute['description'] === '[erased]';

    expect(await handler()).toEqual({ expired: 2, erased: 2, evidenceVersionsDeleted: 0 });
    expect([await isErased(oldest.id), await isErased(newest.id)]).toEqual([true, false]);
    expect(await handler()).toEqual({ expired: 1, erased: 1, evidenceVersionsDeleted: 0 });
    expect(await isErased(newest.id)).toBe(true);
    expect(await handler()).toEqual({ expired: 0, erased: 0, evidenceVersionsDeleted: 0 });
  });

  it('ignores the schedule event content: {now:"2099-…"} changes nothing, only the injected clock counts', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const d = await seedTerminal(owner, 'RESOLVED_ACCEPTED', T);
    const clock = new Date(T.getTime() + 180 * DAY);
    await insertEvidence(owner, d.id, 'PENDING', new Date(clock.getTime() - HOUR));
    const before = await snapshot(owner, d.id);

    const handler = sweeper(db.pool('disputes_retention'), { now: clock });
    expect(await handler({ now: '2099-01-01T00:00:00.000Z', time: '2099-01-01T00:00:00Z' })).toEqual({
      expired: 0,
      erased: 0,
      evidenceVersionsDeleted: 0,
    });
    expect(await snapshot(owner, d.id)).toEqual(before);
    expect(await evidenceStatuses(owner)).toEqual(['STORED', 'REJECTED', 'PENDING']);
  });

  it('emits EvidenceExpired, RetentionErased and RetentionFailed counts as EMF; logs carry the disputeId and no customer text', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const a = await seedTerminal(owner, 'RESOLVED_ACCEPTED', T);
    const b = await seedTerminal(owner, 'WITHDRAWN', T);
    const poison = await seedTerminal(owner, 'RESOLVED_REJECTED', T);
    await insertEvidence(owner, a.id, 'PENDING', T);
    const lines: string[] = [];

    await expect(sweeper(failingEvidenceErase(retention, poison.id), { now: T_PLUS_1Y, lines })()).rejects.toThrow();

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const metric = (name: string) => entries.find((e) => e['msg'] === name);
    expect(metric('EvidenceExpired')).toMatchObject({
      EvidenceExpired: 1,
      _aws: { CloudWatchMetrics: [{ Namespace: 'cd/retention-sweeper', Metrics: [{ Name: 'EvidenceExpired' }] }] },
    });
    expect(metric('RetentionErased')).toMatchObject({ RetentionErased: 2 });
    expect(metric('RetentionFailed')).toMatchObject({
      RetentionFailed: 1,
      _aws: { CloudWatchMetrics: [{ Dimensions: [[]], Metrics: [{ Name: 'RetentionFailed' }] }] },
    });

    const clean: string[] = [];
    await sweeper(retention, { now: T_PLUS_1Y, lines: clean })();
    expect(clean.some((l) => l.includes('RetentionFailed'))).toBe(false);
    expect(entries.filter((e) => e['msg'] === 'dispute erased').map((e) => e['disputeId'])).toEqual(
      expect.arrayContaining([a.disputeId, b.disputeId]),
    );
    const raw = lines.join('\n');
    for (const secret of [DESCRIPTION, RESOLUTION_NOTE, FILE_NAME, 'customer words', 'evidence/']) {
      expect(raw).not.toContain(secret);
    }
  });

  it.each<[string, string, string]>([
    ['PENDING expiry', EXPIRE_PENDING_SQL, 'dispute_evidence_pending_age_idx'],
    ['RESOLVED_* candidates', ERASURE_CANDIDATES_SQL, 'dispute_resolved_unerased_idx'],
    ['WITHDRAWN candidates', ERASURE_CANDIDATES_SQL, 'dispute_status_history_withdraw_idx'],
  ])('the %s query matches its 004 partial index', async (_name, sql, index) => {
    const db = await freshDb();
    const client = await db.pool('disputes_retention').connect();
    try {
      // With seq scans disabled the planner still picks one when no index predicate matches, so this proves the match.
      await client.query('set enable_seqscan = off');
      const r = await client.query(`explain (format json) ${sql}`, [T, 10]);
      expect(JSON.stringify(r.rows[0]['QUERY PLAN'])).toContain(`"Index Name":"${index}"`);
    } finally {
      client.release();
    }
  });
});

const MOTO_IMAGE = 'motoserver/moto:5.2.4';
const REGION = 'eu-north-1';

describe('retention-sweeper deletes evidence bytes after the erase commits (moto S3, versioned bucket)', () => {
  let moto: StartedTestContainer;
  let s3: S3Client;

  beforeAll(async () => {
    moto = await new GenericContainer(MOTO_IMAGE)
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forHttp('/moto-api/', 5000))
      .start();
    s3 = new S3Client({
      region: REGION,
      endpoint: `http://${moto.getHost()}:${moto.getMappedPort(5000)}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  afterAll(async () => {
    await moto?.stop();
  });

  const versionedBucket = async (): Promise<string> => {
    const Bucket = `evidence-${randomUUID().slice(0, 8)}`;
    await s3.send(new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: REGION } }));
    await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    return Bucket;
  };

  const put = (Bucket: string, Key: string, body: string) => s3.send(new PutObjectCommand({ Bucket, Key, Body: body }));

  const versionsUnder = async (Bucket: string, Prefix: string): Promise<string[]> => {
    const r = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix }));
    return [
      ...(r.Versions ?? []).map((v) => `${v.Key}@${v.VersionId}`),
      ...(r.DeleteMarkers ?? []).map((m) => `${m.Key}@${m.VersionId}:marker`),
    ].sort();
  };

  const storedEvidenceId = async (owner: pg.Pool, id: string): Promise<string> => {
    const r = await owner.query<{ evidence_id: string }>(
      `select evidence_id from disputes.dispute_evidence where dispute_id = $1 and status = 'STORED'`,
      [id],
    );
    return r.rows[0]?.evidence_id ?? '';
  };

  // Written out independently of src so a wrong prefix in the sweeper fails the test (ADR-055).
  const keyOf = (disputeId: string, evidenceId: string): string => `evidence/${disputeId}/${evidenceId}`;

  const evidenceFor = (bucket: string, client: Pick<S3Client, 'send'> = s3): EvidenceInput => ({
    s3: client,
    bucket,
    retryDays: 7,
  });

  const failingDeletes = (): Pick<S3Client, 'send'> => ({
    send: ((cmd: unknown) =>
      cmd instanceof DeleteObjectsCommand
        ? Promise.reject(Object.assign(new Error('injected'), { name: 'ServiceUnavailable' }))
        : s3.send(cmd as never)) as S3Client['send'],
  });

  it('deletes every version and delete marker under the erased dispute only; no objects is fine; a re-run is a no-op', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const bucket = await versionedBucket();
    const erasedId = randomUUID();
    const siblingId = `${erasedId.slice(0, -1)}${erasedId.endsWith('0') ? '1' : '0'}`;
    const erased = await seedTerminal(owner, 'RESOLVED_ACCEPTED', T, erasedId);
    const noObjects = await seedTerminal(owner, 'WITHDRAWN', T);
    const sibling = await seedTerminal(owner, 'RESOLVED_REJECTED', new Date(T.getTime() + 30 * DAY), siblingId);

    const erasedKey = keyOf(erasedId, await storedEvidenceId(owner, erased.id));
    await put(bucket, erasedKey, 'v1');
    await put(bucket, erasedKey, 'v2');
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: erasedKey }));
    await put(bucket, keyOf(erasedId, randomUUID()), 'orphan');
    const siblingKey = keyOf(siblingId, await storedEvidenceId(owner, sibling.id));
    await put(bucket, siblingKey, 'v1');
    await put(bucket, siblingKey, 'v2');
    await put(bucket, `evidence/${erasedId}-copy/stray`, 'x');
    const othersBefore = [
      ...(await versionsUnder(bucket, `evidence/${siblingId}`)),
      ...(await versionsUnder(bucket, `evidence/${erasedId}-copy/`)),
    ];
    expect(othersBefore).toHaveLength(3);
    expect(await versionsUnder(bucket, `evidence/${erasedId}/`)).toHaveLength(4);

    const handler = sweeper(retention, { now: T_PLUS_1Y, evidence: evidenceFor(bucket) });
    expect(await handler()).toEqual({ expired: 0, erased: 2, evidenceVersionsDeleted: 4 });
    expect(await versionsUnder(bucket, `evidence/${erasedId}/`)).toEqual([]);
    expect(await versionsUnder(bucket, `evidence/${noObjects.disputeId}/`)).toEqual([]);
    expect([
      ...(await versionsUnder(bucket, `evidence/${siblingId}`)),
      ...(await versionsUnder(bucket, `evidence/${erasedId}-copy/`)),
    ]).toEqual(othersBefore);
    const dbAfter = await snapshot(owner, erased.id);

    expect(await handler()).toEqual({ expired: 0, erased: 0, evidenceVersionsDeleted: 0 });
    expect(await snapshot(owner, erased.id)).toEqual(dbAfter);
    expect(await versionsUnder(bucket, 'evidence/')).toEqual(othersBefore.sort());
  });

  it('an S3 failure keeps the committed erase, fails the run with a metric, and the next run deletes without re-erasing', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const bucket = await versionedBucket();
    const d = await seedTerminal(owner, 'RESOLVED_REJECTED', T);
    const key = keyOf(d.disputeId, await storedEvidenceId(owner, d.id));
    await put(bucket, key, 'v1');
    await put(bucket, key, 'v2');
    const before = await snapshot(owner, d.id);
    const lines: string[] = [];

    await expect(
      sweeper(retention, { now: T_PLUS_1Y, lines, evidence: evidenceFor(bucket, failingDeletes()) })(),
    ).rejects.toThrow('failed to erase 0 dispute(s) and to delete the evidence objects of 1');
    const erasedRow = await snapshot(owner, d.id);
    expectErased(before, erasedRow);
    expect(await versionsUnder(bucket, key)).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({ disputeId: d.disputeId, errorName: 'ServiceUnavailable', msg: 'evidence object deletion failed' }),
    );
    expect(entries.find((e) => e['msg'] === 'EvidenceDeleteFailed')).toMatchObject({ EvidenceDeleteFailed: 1 });
    expect(lines.join('\n')).not.toContain('evidence/');

    expect(await sweeper(retention, { now: T_PLUS_1Y, evidence: evidenceFor(bucket) })()).toEqual({
      expired: 0,
      erased: 0,
      evidenceVersionsDeleted: 2,
    });
    expect(await versionsUnder(bucket, key)).toEqual([]);
    expect(await snapshot(owner, d.id)).toEqual(erasedRow);
  });

  it('stops retrying once the erase is older than the retry window, leaving the bytes to the lifecycle backstop', async () => {
    const db = await freshDb();
    const owner = db.pool('disputes_migrator');
    const retention = db.pool('disputes_retention');
    const bucket = await versionedBucket();
    const d = await seedTerminal(owner, 'WITHDRAWN', T);
    const key = keyOf(d.disputeId, await storedEvidenceId(owner, d.id));
    await put(bucket, key, 'v1');

    await expect(
      sweeper(retention, { now: T_PLUS_1Y, evidence: evidenceFor(bucket, failingDeletes()) })(),
    ).rejects.toThrow();
    // The erase time is the DB clock, so the window is measured from real time here.
    const pastWindow = new Date(Date.now() + 8 * DAY);
    expect(await sweeper(retention, { now: pastWindow, evidence: evidenceFor(bucket) })()).toEqual({
      expired: 0,
      erased: 0,
      evidenceVersionsDeleted: 0,
    });
    expect(await versionsUnder(bucket, key)).toHaveLength(1);
  });
});
