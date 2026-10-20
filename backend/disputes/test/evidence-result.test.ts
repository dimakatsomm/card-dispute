import { randomUUID } from 'node:crypto';
import { parseDisputeEvent } from '@cd/dispute-domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Infra } from '../src/main.ts';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import {
  createFakeUpstreams,
  INTAKE_CALLER,
  SERVICE_CALLER,
  USER_A,
  type FakeUpstreams,
} from './helpers/fakes.ts';
import { seedDispute, seedEvidence } from './helpers/seed.ts';
import { poolPausingAfter, startTestService, type TestService } from './helpers/service.ts';

// Recording a result never signs uploads, so S3 is never contacted.
const UNUSED_S3 = 'http://127.0.0.1:1';

const DECLARED = { sha256: 'a'.repeat(64), sizeBytes: 1024, contentType: 'application/pdf' } as const;
const STORED = { result: 'STORED', ...DECLARED } as const;
const FILE_NAME = 'receipt-from-merchant.pdf';

type DisputeStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'WITHDRAWN';

let db: TestDb;
let upstreams: FakeUpstreams;
let svc: TestService;
const extra: TestService[] = [];

const putResult = (
  transactionId: string,
  evidenceId: string,
  payload: unknown,
  options: { readonly token?: string | null; readonly service?: TestService } = {},
) => {
  const token = options.token === undefined ? INTAKE_CALLER.token : options.token;
  return (options.service ?? svc).servers.service.inject({
    method: 'PUT',
    url: `/dispute/${transactionId}/evidence/${evidenceId}`,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: JSON.stringify(payload),
  });
};

const seedPending = async (
  options: { readonly status?: DisputeStatus; readonly version?: number; readonly fileName?: string } = {},
) => {
  const transactionId = randomUUID();
  const seeded = await seedDispute(db, {
    userId: USER_A.userId,
    transactionId,
    status: options.status ?? 'UNDER_REVIEW',
    version: options.version ?? 3,
  });
  const evidenceId = await seedEvidence(db, seeded, {
    fileName: options.fileName ?? FILE_NAME,
    status: 'PENDING',
    ...DECLARED,
  });
  return { transactionId, disputeId: seeded.disputeId, rowId: seeded.rowId, evidenceId };
};

const evidenceRow = async (evidenceId: string) =>
  (
    await db.appQuery(
      'select status, s3_key, rejection_reason, stored_at is not null as has_stored_at from dispute_evidence where evidence_id = $1',
      [evidenceId],
    )
  ).rows[0] as Record<string, unknown>;

const historyOf = async (transactionId: string) =>
  (
    await db.appQuery(
      `select h.action, h.from_status, h.to_status, h.actor_type, h.actor_id, h.note, h.before, h.after
       from dispute_status_history h join dispute d on d.id = h.dispute_id
       where d.transaction_id = $1 order by h.id`,
      [transactionId],
    )
  ).rows;

const disputeState = async (transactionId: string) =>
  (
    await db.appQuery('select status, version, updated_at from dispute where transaction_id = $1', [
      transactionId,
    ])
  ).rows[0] as { status: string; version: number; updated_at: Date };

const eventsFor = (service: TestService, transactionId: string) =>
  service.messages
    .filter((m) => m.body.includes(transactionId))
    .map((m) => JSON.parse(m.body) as Record<string, unknown>);

const added = (evidenceId: string, status: DisputeStatus = 'UNDER_REVIEW') => ({
  action: 'EVIDENCE_ADDED',
  from_status: status,
  to_status: status,
  actor_type: 'SYSTEM_RULE',
  actor_id: 'evidence-intake',
  note: null,
  before: null,
  after: { evidenceId },
});

const rejected = (evidenceId: string) => ({ ...added(evidenceId), action: 'EVIDENCE_REJECTED' });

const waitFor = async (check: () => Promise<boolean>, deadline = Date.now() + 10_000): Promise<void> => {
  if (await check()) return;
  if (Date.now() > deadline) throw new Error('condition not reached');
  await new Promise((resolve) => setTimeout(resolve, 25));
  return waitFor(check, deadline);
};

// Holds the transaction right after the evidence UPDATE until released, so a competing writer meets the row lock.
const poolGatedAfterSettle = (pool: pg.Pool) => {
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reachedP = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: Infra['pool'] = {
    query: pool.query.bind(pool) as Infra['pool']['query'],
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get: (target, prop, receiver) => {
          if (prop === 'query') {
            return async (sql: unknown, ...rest: unknown[]) => {
              const result: unknown = await (target.query as (...a: unknown[]) => unknown).call(
                target,
                sql,
                ...rest,
              );
              if (typeof sql === 'string' && sql.includes('update dispute_evidence')) {
                reached();
                await gate;
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
  return { pool: gated, reached: reachedP, release: () => release() };
};

beforeAll(async () => {
  db = await startDisputesDb();
  upstreams = createFakeUpstreams();
  svc = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3 });
});

afterAll(async () => {
  await Promise.all(extra.map((s) => s.servers.close()));
  await svc?.servers.close();
  await db?.stop();
});

describe('PUT :8081/dispute/{transactionId}/evidence/{evidenceId} — guard', () => {
  it('is not on the public port (8080) → 404', async () => {
    const res = await svc.servers.public.inject({
      method: 'PUT',
      url: `/dispute/${randomUUID()}/evidence/${randomUUID()}`,
      headers: { authorization: `Bearer ${INTAKE_CALLER.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(STORED),
    });
    expect(res.statusCode).toBe(404);
  });

  it('a user token → 403', async () => {
    const { transactionId, evidenceId } = await seedPending();
    expect((await putResult(transactionId, evidenceId, STORED, { token: USER_A.token })).statusCode).toBe(
      403,
    );
    expect((await evidenceRow(evidenceId)).status).toBe('PENDING');
  });

  it('a service token with disputes/read instead of disputes/evidence.write → 403', async () => {
    const { transactionId, evidenceId } = await seedPending();
    expect(
      (await putResult(transactionId, evidenceId, STORED, { token: SERVICE_CALLER.token })).statusCode,
    ).toBe(403);
    expect((await evidenceRow(evidenceId)).status).toBe('PENDING');
  });

  it('no token → 401', async () => {
    const { transactionId, evidenceId } = await seedPending();
    expect((await putResult(transactionId, evidenceId, STORED, { token: null })).statusCode).toBe(401);
    expect((await evidenceRow(evidenceId)).status).toBe('PENDING');
  });
});

describe('PUT :8081/dispute/{transactionId}/evidence/{evidenceId}', () => {
  it('STORED with the declared facts → 200 with the derived s3Key, EVIDENCE_ADDED history, EvidenceStored; dispute version and updated_at unchanged', async () => {
    const { transactionId, disputeId, evidenceId } = await seedPending({ version: 3 });
    const before = await disputeState(transactionId);

    const res = await putResult(transactionId, evidenceId, STORED);

    expect(res.statusCode).toBe(200);
    expectContract('recordEvidenceResult', res.json());
    expect(res.json()).toEqual({
      evidenceId,
      status: 'STORED',
      s3Key: `evidence/${disputeId}/${evidenceId}`,
    });
    expect(await evidenceRow(evidenceId)).toEqual({
      status: 'STORED',
      s3_key: `evidence/${disputeId}/${evidenceId}`,
      rejection_reason: null,
      has_stored_at: true,
    });
    expect(await historyOf(transactionId)).toEqual([added(evidenceId)]);
    expect(await disputeState(transactionId)).toEqual(before);

    const events = eventsFor(svc, transactionId);
    expect(events).toHaveLength(1);
    expect(parseDisputeEvent(events[0])).toMatchObject({ ok: true });
    expect(events[0]).toMatchObject({
      eventType: 'EvidenceStored',
      disputeId,
      transactionId,
      userId: USER_A.userId,
      version: 3,
      data: { evidence: { evidenceId } },
    });
    expect(JSON.stringify(events[0])).not.toContain(FILE_NAME);
  });

  it("a customer's If-Match from before the result still works", async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const seeded = await seedDispute(db, {
      userId: USER_A.userId,
      transactionId: txn.transactionId,
      version: 1,
    });
    const evidenceId = await seedEvidence(db, seeded, {
      fileName: FILE_NAME,
      status: 'PENDING',
      ...DECLARED,
    });

    expect((await putResult(txn.transactionId, evidenceId, STORED)).statusCode).toBe(200);
    const edit = await svc.servers.public.inject({
      method: 'PUT',
      url: `/dispute/${txn.transactionId}`,
      headers: {
        authorization: `Bearer ${USER_A.token}`,
        'content-type': 'application/json',
        'if-match': '"1"',
      },
      payload: JSON.stringify({ action: 'EDIT', reasonCode: 'NOT_RECEIVED' }),
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ version: 2, reasonCode: 'NOT_RECEIVED' });
  });

  it('an s3Key in the body is refused (400): the key is never read from the caller', async () => {
    const { transactionId, evidenceId } = await seedPending();
    const res = await putResult(transactionId, evidenceId, { ...STORED, s3Key: 'evidence/attacker/chosen' });
    expect(res.statusCode).toBe(400);
    expect(await evidenceRow(evidenceId)).toMatchObject({ status: 'PENDING', s3_key: null });
  });

  it.each([
    { reason: 'TYPE_MISMATCH', facts: { contentType: 'image/png' } },
    { reason: 'SIZE', facts: { sizeBytes: 1025 } },
    { reason: 'CHECKSUM', facts: { sha256: 'b'.repeat(64) } },
  ] as const)(
    'STORED whose facts differ ($reason) → recorded REJECTED $reason and answered 200 REJECTED without s3Key',
    async ({ reason, facts }) => {
      const { transactionId, evidenceId } = await seedPending();

      const res = await putResult(transactionId, evidenceId, { ...STORED, ...facts });

      expect(res.statusCode).toBe(200);
      expectContract('recordEvidenceResult', res.json());
      expect(res.json()).toEqual({ evidenceId, status: 'REJECTED' });
      expect(await evidenceRow(evidenceId)).toEqual({
        status: 'REJECTED',
        s3_key: null,
        rejection_reason: reason,
        has_stored_at: false,
      });
      expect(await historyOf(transactionId)).toEqual([rejected(evidenceId)]);
      const events = eventsFor(svc, transactionId);
      expect(events).toHaveLength(1);
      expect(parseDisputeEvent(events[0])).toMatchObject({ ok: true });
      expect(events[0]).toMatchObject({
        eventType: 'EvidenceRejected',
        data: { evidence: { evidenceId, reason } },
      });
    },
  );

  it('GET /dispute shows EVIDENCE_ADDED with the file name and EVIDENCE_REJECTED (SCAN_FAILED, no facts) with the reason', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const seeded = await seedDispute(db, { userId: USER_A.userId, transactionId: txn.transactionId });
    const good = await seedEvidence(db, seeded, { fileName: 'receipt.pdf', status: 'PENDING', ...DECLARED });
    const bad = await seedEvidence(db, seeded, { fileName: 'statement.pdf', status: 'PENDING', ...DECLARED });

    expect((await putResult(txn.transactionId, good, STORED)).json()).toMatchObject({ status: 'STORED' });
    const scanFailed = await putResult(txn.transactionId, bad, { result: 'REJECTED', reason: 'SCAN_FAILED' });
    expect(scanFailed.statusCode).toBe(200);
    expect(scanFailed.json()).toEqual({ evidenceId: bad, status: 'REJECTED' });

    const res = await svc.servers.public.inject({
      method: 'GET',
      url: `/dispute/${txn.transactionId}`,
      headers: { authorization: `Bearer ${USER_A.token}` },
    });
    expect(res.statusCode).toBe(200);
    expectContract('detail', res.json());
    const body = res.json<{ timeline: ReadonlyArray<Record<string, unknown>>; evidence: unknown }>();
    expect(body.timeline.filter((e) => String(e.type).startsWith('EVIDENCE_'))).toMatchObject([
      { type: 'EVIDENCE_ADDED', by: 'CUSTOMER', detail: { fileName: 'receipt.pdf' } },
      { type: 'EVIDENCE_REJECTED', by: 'BANK', detail: { fileName: 'statement.pdf', reason: 'SCAN_FAILED' } },
    ]);
    expect(body.evidence).toMatchObject([
      { evidenceId: good, status: 'STORED' },
      { evidenceId: bad, status: 'REJECTED' },
    ]);
  });

  it('a result for a WITHDRAWN dispute is still recorded, with from = to = WITHDRAWN', async () => {
    const { transactionId, evidenceId } = await seedPending({ status: 'WITHDRAWN' });
    expect((await putResult(transactionId, evidenceId, STORED)).statusCode).toBe(200);
    expect(await historyOf(transactionId)).toEqual([added(evidenceId, 'WITHDRAWN')]);
  });

  it("an unknown evidenceId, another dispute's evidenceId or an unknown transaction → 404, nothing changes", async () => {
    const mine = await seedPending();
    const other = await seedPending();

    const unknownEvidence = await putResult(mine.transactionId, randomUUID(), STORED);
    const othersEvidence = await putResult(mine.transactionId, other.evidenceId, STORED);
    const unknownTxn = await putResult(randomUUID(), mine.evidenceId, STORED);

    expect([unknownEvidence.statusCode, othersEvidence.statusCode, unknownTxn.statusCode]).toEqual([
      404, 404, 404,
    ]);
    expect(othersEvidence.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await evidenceRow(mine.evidenceId)).status).toBe('PENDING');
    expect((await evidenceRow(other.evidenceId)).status).toBe('PENDING');
    expect(await historyOf(mine.transactionId)).toEqual([]);
    expect(await historyOf(other.transactionId)).toEqual([]);
  });

  it('body: REJECTED without a reason → 400; STORED without facts → 400', async () => {
    const { transactionId, evidenceId } = await seedPending();
    expect((await putResult(transactionId, evidenceId, { result: 'REJECTED' })).statusCode).toBe(400);
    expect((await putResult(transactionId, evidenceId, { result: 'STORED' })).statusCode).toBe(400);
    expect((await evidenceRow(evidenceId)).status).toBe('PENDING');
  });

  it.each([
    { name: 'STORED', first: STORED, expected: 'STORED' },
    { name: 'a mismatch recorded REJECTED', first: { ...STORED, sizeBytes: 9 }, expected: 'REJECTED' },
    { name: 'REJECTED', first: { result: 'REJECTED', reason: 'MALWARE' }, expected: 'REJECTED' },
  ] as const)(
    'an identical repeat of $name → 200 with the same answer, no second history row or event',
    async ({ first, expected }) => {
      const { transactionId, evidenceId } = await seedPending();
      const one = await putResult(transactionId, evidenceId, first);
      const two = await putResult(transactionId, evidenceId, first);

      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      expect(two.json()).toEqual(one.json());
      expect(two.json()).toMatchObject({ status: expected });
      expect(await historyOf(transactionId)).toHaveLength(1);
      expect(eventsFor(svc, transactionId)).toHaveLength(1);
    },
  );

  it.each([
    {
      name: 'STORED then REJECTED',
      first: STORED,
      second: { result: 'REJECTED', reason: 'MALWARE' },
      kept: 'STORED',
    },
    {
      name: 'REJECTED then STORED',
      first: { result: 'REJECTED', reason: 'MALWARE' },
      second: STORED,
      kept: 'REJECTED',
    },
  ] as const)('$name → 409 RESULT_CONFLICT; the first result stands', async ({ first, second, kept }) => {
    const { transactionId, evidenceId } = await seedPending();
    expect((await putResult(transactionId, evidenceId, first)).statusCode).toBe(200);

    const res = await putResult(transactionId, evidenceId, second);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'RESULT_CONFLICT' });
    expect((await evidenceRow(evidenceId)).status).toBe(kept);
    expect(await historyOf(transactionId)).toHaveLength(1);
    expect(eventsFor(svc, transactionId)).toHaveLength(1);
  });

  it.each(['EXPIRED', 'ERASED'] as const)(
    'a result for %s evidence → 409 EVIDENCE_CLOSED, nothing changes',
    async (closed) => {
      const { transactionId, evidenceId } = await seedPending();
      // Moved by the sweeper's own role, the only one allowed to set either status.
      await db.retentionPool.query(
        'update disputes.dispute_evidence set status = $2 where evidence_id = $1',
        [evidenceId, closed],
      );

      const res = await putResult(transactionId, evidenceId, STORED);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'EVIDENCE_CLOSED' });
      expect(await evidenceRow(evidenceId)).toMatchObject({ status: closed, s3_key: null });
      expect(await historyOf(transactionId)).toEqual([]);
      expect(eventsFor(svc, transactionId)).toEqual([]);
    },
  );

  it('a publish failure still gives 200 with the result committed and EventPublishFailed logged', async () => {
    const failing = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: UNUSED_S3,
      send: () => Promise.reject(new Error('sqs down')),
    });
    extra.push(failing);
    const { transactionId, evidenceId } = await seedPending();

    const res = await putResult(transactionId, evidenceId, STORED, { service: failing });

    expect(res.statusCode).toBe(200);
    expect((await evidenceRow(evidenceId)).status).toBe('STORED');
    expect(await historyOf(transactionId)).toHaveLength(1);
    expect(failing.logLines().find((l) => l.EventPublishFailed === 1)).toMatchObject({
      eventType: 'EvidenceStored',
    });
  });
});

describe('PUT …/evidence/{evidenceId} — concurrency (two connections)', () => {
  it('two concurrent identical PUTs → both 200, one history row, one event', async () => {
    const overlapping = await startTestService({
      pool: poolPausingAfter(db.appPool, 'update dispute_evidence', 300),
      upstreams,
      s3Endpoint: UNUSED_S3,
    });
    extra.push(overlapping);
    const { transactionId, evidenceId } = await seedPending();

    const results = await Promise.all([
      putResult(transactionId, evidenceId, STORED, { service: overlapping }),
      putResult(transactionId, evidenceId, STORED, { service: overlapping }),
    ]);

    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.map((r) => r.json<{ status: string }>().status)).toEqual(['STORED', 'STORED']);
    expect(await historyOf(transactionId)).toHaveLength(1);
    expect(eventsFor(overlapping, transactionId)).toHaveLength(1);
  });

  it("the sweeper's PENDING → EXPIRED commits first: the PUT waits on its lock, then 409 EVIDENCE_CLOSED with no history", async () => {
    const { transactionId, evidenceId } = await seedPending();
    const sweeper = await db.retentionPool.connect();
    try {
      await sweeper.query('begin');
      const swept = await sweeper.query(
        "update disputes.dispute_evidence set status = 'EXPIRED' where evidence_id = $1 and status = 'PENDING'",
        [evidenceId],
      );
      expect(swept.rowCount).toBe(1);

      const pending = putResult(transactionId, evidenceId, STORED);
      await waitFor(async () => {
        const res = await db.appQuery('select count(*)::int as n from pg_locks where not granted');
        return (res.rows[0] as { n: number }).n > 0;
      });
      await sweeper.query('commit');

      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'EVIDENCE_CLOSED' });
    } finally {
      sweeper.release();
    }
    expect(await evidenceRow(evidenceId)).toEqual({
      status: 'EXPIRED',
      s3_key: null,
      rejection_reason: null,
      has_stored_at: false,
    });
    expect(await historyOf(transactionId)).toEqual([]);
    expect(eventsFor(svc, transactionId)).toEqual([]);
  });

  it("the PUT settles first: the sweeper's PENDING-only update then changes nothing; STORED with exactly one history row", async () => {
    const gated = poolGatedAfterSettle(db.appPool);
    const service = await startTestService({ pool: gated.pool, upstreams, s3Endpoint: UNUSED_S3 });
    extra.push(service);
    const { transactionId, disputeId, evidenceId } = await seedPending();

    const pending = putResult(transactionId, evidenceId, STORED, { service });
    await gated.reached;
    const sweep = db.retentionPool.query(
      "update disputes.dispute_evidence set status = 'EXPIRED' where evidence_id = $1 and status = 'PENDING'",
      [evidenceId],
    );
    await waitFor(async () => {
      const res = await db.appQuery('select count(*)::int as n from pg_locks where not granted');
      return (res.rows[0] as { n: number }).n > 0;
    });
    gated.release();

    expect((await pending).statusCode).toBe(200);
    expect((await sweep).rowCount).toBe(0);
    expect(await evidenceRow(evidenceId)).toEqual({
      status: 'STORED',
      s3_key: `evidence/${disputeId}/${evidenceId}`,
      rejection_reason: null,
      has_stored_at: true,
    });
    expect(await historyOf(transactionId)).toEqual([added(evidenceId)]);
  });
});
