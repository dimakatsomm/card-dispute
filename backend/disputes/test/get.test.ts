import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisputeRepo } from '../src/adapters/dispute-repo.ts';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import { createFakeUpstreams, json, URLS, USER_A, USER_B, type FakeUpstreams } from './helpers/fakes.ts';
import { DESCRIPTION, seedDispute, seedEvidence, seedHistory } from './helpers/seed.ts';
import { startTestService, type TestService } from './helpers/service.ts';

// Reads never sign uploads, so S3 is never contacted.
const UNUSED_S3 = 'http://127.0.0.1:1';
const AGENT_SUB = 'agent-sub-7f3c9e1d';
const INTAKE_ID = 'evidence-intake-lambda';
const REVIEW_NOTE = 'internal: customer called twice, escalate';
const RESOLUTION_NOTE = 'The merchant provided proof of delivery.';

let db: TestDb;
let upstreams: FakeUpstreams;
let svc: TestService;

const get = (service: TestService, token: string, transactionId: string) =>
  service.servers.public.inject({
    method: 'GET',
    url: `/dispute/${transactionId}`,
    headers: { authorization: `Bearer ${token}` },
  });

const transactionCalls = () =>
  upstreams.calls.filter((c) => c.url.origin === URLS.transactions && c.url.pathname === '/transactions')
    .length;

const seedFullHistory = async () => {
  const txn = upstreams.addTransaction(USER_A.userId);
  const seeded = await seedDispute(db, {
    userId: USER_A.userId,
    transactionId: txn.transactionId,
    status: 'RESOLVED_REJECTED',
    version: 4,
    updatedAt: '2026-10-06T09:00:00.000000Z',
    resolutionNote: RESOLUTION_NOTE,
  });
  const receipt = await seedEvidence(db, seeded, { fileName: 'receipt.pdf', status: 'STORED' });
  const bad = await seedEvidence(db, seeded, {
    fileName: 'invoice.pdf',
    status: 'REJECTED',
    rejectionReason: 'MALWARE',
  });
  const user = { actorType: 'USER', actorId: USER_A.userId } as const;
  const agent = { actorType: 'AGENT', actorId: AGENT_SUB } as const;
  const intake = { actorType: 'SYSTEM_RULE', actorId: INTAKE_ID } as const;
  // Inserted out of time order to prove the timeline is sorted, not just echoed.
  await seedHistory(db, seeded.rowId, {
    ...agent,
    action: 'RESOLVE',
    fromStatus: 'UNDER_REVIEW',
    toStatus: 'RESOLVED_REJECTED',
    note: RESOLUTION_NOTE,
    createdAt: '2026-10-06T09:00:00.000000Z',
  });
  await seedHistory(db, seeded.rowId, {
    ...user,
    action: 'CREATE',
    fromStatus: null,
    toStatus: 'SUBMITTED',
    createdAt: '2026-10-01T08:00:00.000000Z',
  });
  await seedHistory(db, seeded.rowId, {
    ...intake,
    action: 'EVIDENCE_ADDED',
    fromStatus: 'SUBMITTED',
    toStatus: 'SUBMITTED',
    after: { evidenceId: receipt },
    createdAt: '2026-10-01T08:05:00.000000Z',
  });
  await seedHistory(db, seeded.rowId, {
    ...intake,
    action: 'EVIDENCE_REJECTED',
    fromStatus: 'SUBMITTED',
    toStatus: 'SUBMITTED',
    after: { evidenceId: bad },
    createdAt: '2026-10-01T08:06:00.000000Z',
  });
  await seedHistory(db, seeded.rowId, {
    ...user,
    action: 'EDIT',
    fromStatus: 'SUBMITTED',
    toStatus: 'SUBMITTED',
    before: { description: 'old text that was replaced' },
    after: { description: DESCRIPTION },
    createdAt: '2026-10-02T10:00:00.000000Z',
  });
  await seedHistory(db, seeded.rowId, {
    ...agent,
    action: 'REVIEW',
    fromStatus: 'SUBMITTED',
    toStatus: 'UNDER_REVIEW',
    note: REVIEW_NOTE,
    createdAt: '2026-10-03T11:00:00.000000Z',
  });
  return { txn, seeded, receipt, bad };
};

beforeAll(async () => {
  db = await startDisputesDb();
  upstreams = createFakeUpstreams();
  svc = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3 });
});

afterAll(async () => {
  await svc?.servers.close();
  await db?.stop();
});

describe('GET /dispute/{transactionId}', () => {
  it('returns the resource, ETag = version, transaction from one batch call, and an ascending CUSTOMER/BANK timeline', async () => {
    const { txn, seeded, receipt, bad } = await seedFullHistory();
    const callsBefore = transactionCalls();

    const res = await get(svc, USER_A.token, txn.transactionId);

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"4"');
    expect(transactionCalls() - callsBefore).toBe(1);
    const body = res.json();
    expectContract('detail', body);
    expect(body).toMatchObject({
      disputeId: seeded.disputeId,
      transactionId: txn.transactionId,
      status: 'RESOLVED_REJECTED',
      version: 4,
      resolutionNote: RESOLUTION_NOTE,
      transaction: { accountId: txn.accountId, cardId: txn.cardId, amount: '125.50', currency: 'ZAR' },
      evidence: [
        { evidenceId: receipt, fileName: 'receipt.pdf', status: 'STORED' },
        { evidenceId: bad, fileName: 'invoice.pdf', status: 'REJECTED', rejectionReason: 'MALWARE' },
      ],
    });
    expect(body.timeline).toEqual([
      { type: 'SUBMITTED', at: '2026-10-01T08:00:00.000Z', by: 'CUSTOMER' },
      {
        type: 'EVIDENCE_ADDED',
        at: '2026-10-01T08:05:00.000Z',
        by: 'CUSTOMER',
        detail: { fileName: 'receipt.pdf' },
      },
      {
        type: 'EVIDENCE_REJECTED',
        at: '2026-10-01T08:06:00.000Z',
        by: 'BANK',
        detail: { fileName: 'invoice.pdf', reason: 'MALWARE' },
      },
      { type: 'EDITED', at: '2026-10-02T10:00:00.000Z', by: 'CUSTOMER', detail: { fields: ['description'] } },
      { type: 'UNDER_REVIEW', at: '2026-10-03T11:00:00.000Z', by: 'BANK' },
      {
        type: 'RESOLVED_REJECTED',
        at: '2026-10-06T09:00:00.000Z',
        by: 'BANK',
        detail: { note: RESOLUTION_NOTE },
      },
    ]);
  });

  it('never exposes actor ids, actor types, internal review notes or edited values', async () => {
    const { txn } = await seedFullHistory();
    const raw = (await get(svc, USER_A.token, txn.transactionId)).body;
    for (const secret of [
      AGENT_SUB,
      INTAKE_ID,
      USER_A.userId,
      'AGENT',
      'SYSTEM_RULE',
      'actor',
      REVIEW_NOTE,
      'old text that was replaced',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("user B on user A's transaction → 404", async () => {
    const { txn } = await seedFullHistory();
    const res = await get(svc, USER_B.token, txn.transactionId);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('no dispute for the transaction → 404', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    expect((await get(svc, USER_A.token, txn.transactionId)).statusCode).toBe(404);
    expect((await get(svc, USER_A.token, randomUUID())).statusCode).toBe(404);
  });

  it('transactions unavailable → 200 with transaction: null', async () => {
    const { txn, seeded } = await seedFullHistory();
    const down = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: UNUSED_S3,
      fault: (url) => (url.origin === URLS.transactions ? Promise.resolve(json(502, {})) : undefined),
    });
    try {
      const res = await get(down, USER_A.token, txn.transactionId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ disputeId: seeded.disputeId, transaction: null });
    } finally {
      await down.servers.close();
    }
  });

  it('reads the dispute, history and evidence from one snapshot, so a commit mid-read changes neither ETag nor timeline', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const seeded = await seedDispute(db, { userId: USER_A.userId, transactionId: txn.transactionId });
    await seedHistory(db, seeded.rowId, {
      action: 'CREATE',
      fromStatus: null,
      toStatus: 'SUBMITTED',
      actorType: 'USER',
      actorId: USER_A.userId,
      createdAt: '2026-10-01T08:00:00.000000Z',
    });
    const withdrawConcurrently = async () => {
      await db.appQuery(
        `update dispute set status = 'WITHDRAWN', version = version + 1, updated_by = $2 where id = $1`,
        [seeded.rowId, `USER:${USER_A.userId}`],
      );
      await seedHistory(db, seeded.rowId, {
        action: 'WITHDRAW',
        fromStatus: 'SUBMITTED',
        toStatus: 'WITHDRAWN',
        actorType: 'USER',
        actorId: USER_A.userId,
        createdAt: '2026-10-02T08:00:00.000000Z',
      });
    };
    // Commits the withdrawal on another connection just before the history statement runs.
    const racingPool = {
      query: db.appPool.query.bind(db.appPool),
      connect: async () => {
        const client = await db.appPool.connect();
        const query = (client.query as (...args: unknown[]) => Promise<unknown>).bind(client);
        return new Proxy(client, {
          get: (target, prop, receiver) => {
            if (prop === 'query') {
              return async (sql: unknown, ...rest: unknown[]) => {
                if (typeof sql === 'string' && sql.includes('from dispute_status_history')) {
                  await withdrawConcurrently();
                }
                return query(sql, ...rest);
              };
            }
            const value: unknown = Reflect.get(target, prop, receiver);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const key = { transactionId: txn.transactionId, userId: USER_A.userId };

    const raced = await createDisputeRepo(racingPool).findLatestWithHistory(key);
    expect(raced?.dispute).toMatchObject({ status: 'SUBMITTED', version: 1 });
    expect(raced?.history.map((h) => h.action)).toEqual(['CREATE']);

    const after = await createDisputeRepo(db.appPool).findLatestWithHistory(key);
    expect(after?.dispute).toMatchObject({ status: 'WITHDRAWN', version: 2 });
    expect(after?.history.map((h) => h.action)).toEqual(['CREATE', 'WITHDRAW']);
  });
});
