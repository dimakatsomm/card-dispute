import { randomUUID } from 'node:crypto';
import { parseDisputeEvent } from '@cd/dispute-domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisputeRepo } from '../src/adapters/dispute-repo.ts';
import { updateDispute } from '../src/use-cases/update-dispute.ts';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import {
  createFakeUpstreams,
  hang,
  json,
  URLS,
  USER_A,
  USER_B,
  type FakeUpstreams,
} from './helpers/fakes.ts';
import { poolFailingOn, QUEUE_URL, startTestService, type TestService } from './helpers/service.ts';

// The update path never signs uploads, so S3 is never contacted.
const UNUSED_S3 = 'http://127.0.0.1:1';
const DESCRIPTION = 'I did not make this purchase; my card was with me.';
const NEW_DESCRIPTION = 'Merchant charged me but the parcel never arrived at all.';

type Status = 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'WITHDRAWN';

let db: TestDb;
let upstreams: FakeUpstreams;
let svc: TestService;

const put = (
  service: TestService,
  token: string,
  transactionId: string,
  payload: unknown,
  ifMatch: string | null = '"1"',
) =>
  service.servers.public.inject({
    method: 'PUT',
    url: `/dispute/${transactionId}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(ifMatch === null ? {} : { 'if-match': ifMatch }),
    },
    payload: JSON.stringify(payload),
  });

const seed = async (userId: string, status: Status = 'SUBMITTED'): Promise<string> => {
  const txn = upstreams.addTransaction(userId);
  await db.appQuery(
    `insert into dispute (transaction_id, user_id, reason_code, description, status, resolved_at, created_by, updated_by)
     values ($1, $2, 'FRAUD', $3, $4, $5, $6, $6)`,
    [
      txn.transactionId,
      userId,
      DESCRIPTION,
      status,
      status.startsWith('RESOLVED_') ? new Date() : null,
      `USER:${userId}`,
    ],
  );
  return txn.transactionId;
};

const stored = async (transactionId: string) =>
  (
    await db.appQuery(
      'select status, reason_code, description, version, updated_by from dispute where transaction_id = $1',
      [transactionId],
    )
  ).rows[0] as Record<string, unknown>;

const history = async (transactionId: string) =>
  (
    await db.appQuery(
      `select h.action, h.from_status, h.to_status, h.actor_type, h.actor_id, h.note, h.before, h.after
       from dispute_status_history h join dispute d on d.id = h.dispute_id
       where d.transaction_id = $1 order by h.id`,
      [transactionId],
    )
  ).rows;

const eventsFor = (service: TestService, transactionId: string) =>
  service.messages
    .filter((m) => m.body.includes(transactionId))
    .map((m) => ({ queueUrl: m.queueUrl, event: JSON.parse(m.body) as Record<string, unknown> }));

const UNCHANGED = { status: 'SUBMITTED', reason_code: 'FRAUD', description: DESCRIPTION, version: 1 };

beforeAll(async () => {
  db = await startDisputesDb();
  upstreams = createFakeUpstreams();
  svc = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3 });
});

afterAll(async () => {
  await svc?.servers.close();
  await db?.stop();
});

describe('PUT /dispute/{transactionId}', () => {
  it('EDIT in SUBMITTED → 200 with ETag = version, history of changed fields only, DisputeEdited after commit', async () => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_A.token, transactionId, {
      action: 'EDIT',
      reasonCode: 'FRAUD',
      description: NEW_DESCRIPTION,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expectContract('update', res.json());
    expect(res.json()).toMatchObject({
      transactionId,
      status: 'SUBMITTED',
      reasonCode: 'FRAUD',
      description: NEW_DESCRIPTION,
      version: 2,
      evidence: [],
      transaction: { amount: '125.50', currency: 'ZAR' },
    });
    expect(await stored(transactionId)).toMatchObject({
      description: NEW_DESCRIPTION,
      version: 2,
      updated_by: `USER:${USER_A.userId}`,
    });
    expect(await history(transactionId)).toEqual([
      {
        action: 'EDIT',
        from_status: 'SUBMITTED',
        to_status: 'SUBMITTED',
        actor_type: 'USER',
        actor_id: USER_A.userId,
        note: null,
        before: { description: DESCRIPTION },
        after: { description: NEW_DESCRIPTION },
      },
    ]);
    const events = eventsFor(svc, transactionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.queueUrl).toBe(QUEUE_URL);
    expect(events[0]?.event).toMatchObject({
      eventType: 'DisputeEdited',
      transactionId,
      userId: USER_A.userId,
      version: 2,
      data: { fromStatus: 'SUBMITTED', toStatus: 'SUBMITTED', reasonCode: 'FRAUD' },
    });
    expect(JSON.stringify(events[0]?.event)).not.toContain(NEW_DESCRIPTION);
    expect(parseDisputeEvent(events[0]?.event)).toMatchObject({ ok: true });
  });

  it.each(['SUBMITTED', 'UNDER_REVIEW'] as const)(
    'WITHDRAW in %s → 200 WITHDRAWN, status history row by the customer, DisputeStatusChanged',
    async (status) => {
      const transactionId = await seed(USER_A.userId, status);
      const res = await put(svc, USER_A.token, transactionId, {
        action: 'WITHDRAW',
        note: 'Resolved with merchant',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers.etag).toBe('"2"');
      expect(res.json()).toMatchObject({ status: 'WITHDRAWN', version: 2 });
      expect(await stored(transactionId)).toMatchObject({ status: 'WITHDRAWN', version: 2 });
      expect(await history(transactionId)).toEqual([
        {
          action: 'WITHDRAW',
          from_status: status,
          to_status: 'WITHDRAWN',
          actor_type: 'USER',
          actor_id: USER_A.userId,
          note: 'Resolved with merchant',
          before: null,
          after: null,
        },
      ]);
      expect(eventsFor(svc, transactionId).map((e) => e.event)).toMatchObject([
        {
          eventType: 'DisputeStatusChanged',
          version: 2,
          data: { fromStatus: status, toStatus: 'WITHDRAWN' },
        },
      ]);
      expect(parseDisputeEvent(eventsFor(svc, transactionId)[0]?.event)).toMatchObject({ ok: true });
    },
  );

  it("user B on user A's dispute → 404 and nothing changes", async () => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_B.token, transactionId, { action: 'WITHDRAW' });

    expect(res.statusCode).toBe(404);
    expect(await stored(transactionId)).toMatchObject(UNCHANGED);
    expect(await history(transactionId)).toEqual([]);
    expect(eventsFor(svc, transactionId)).toEqual([]);
  });

  it('no dispute for the transaction → 404', async () => {
    const res = await put(svc, USER_A.token, randomUUID(), { action: 'WITHDRAW' });
    expect(res.statusCode).toBe(404);
  });

  it('missing If-Match → 428, nothing changes', async () => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_A.token, transactionId, { action: 'WITHDRAW' }, null);

    expect(res.statusCode).toBe(428);
    expect(await stored(transactionId)).toMatchObject(UNCHANGED);
  });

  it('missing If-Match is checked before the body → 428 even for an invalid body', async () => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_A.token, transactionId, { action: 'DELETE' }, null);
    expect(res.statusCode).toBe(428);
  });

  it.each(['"2"', '"0"', '*', '1', 'W/"1"'])(
    'If-Match %s on version 1 → 412, nothing changes',
    async (ifMatch) => {
      const transactionId = await seed(USER_A.userId);
      const res = await put(svc, USER_A.token, transactionId, { action: 'WITHDRAW' }, ifMatch);

      expect(res.statusCode).toBe(412);
      expect(await stored(transactionId)).toMatchObject(UNCHANGED);
      expect(await history(transactionId)).toEqual([]);
    },
  );

  it.each([
    { status: 'UNDER_REVIEW', action: 'EDIT' },
    { status: 'RESOLVED_ACCEPTED', action: 'EDIT' },
    { status: 'RESOLVED_ACCEPTED', action: 'WITHDRAW' },
    { status: 'RESOLVED_REJECTED', action: 'WITHDRAW' },
    { status: 'WITHDRAWN', action: 'EDIT' },
    { status: 'WITHDRAWN', action: 'WITHDRAW' },
  ] as const)('$action in $status → 409 INVALID_TRANSITION, nothing changes', async ({ status, action }) => {
    const transactionId = await seed(USER_A.userId, status);
    const res = await put(
      svc,
      USER_A.token,
      transactionId,
      action === 'EDIT' ? { action, description: NEW_DESCRIPTION } : { action },
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await stored(transactionId)).toMatchObject({ status, description: DESCRIPTION, version: 1 });
    expect(await history(transactionId)).toEqual([]);
    expect(eventsFor(svc, transactionId)).toEqual([]);
  });

  it('two concurrent PUTs with the same If-Match → one 200, one 412', async () => {
    const transactionId = await seed(USER_A.userId);
    const results = await Promise.all([
      put(svc, USER_A.token, transactionId, { action: 'EDIT', description: NEW_DESCRIPTION }),
      put(svc, USER_A.token, transactionId, { action: 'WITHDRAW' }),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    expect(await stored(transactionId)).toMatchObject({ version: 2 });
    expect(await history(transactionId)).toHaveLength(1);
    expect(eventsFor(svc, transactionId)).toHaveLength(1);
  });

  it.each([
    { name: 'unknown reasonCode', body: { reasonCode: 'BORED' }, code: 'INVALID_REASON' },
    { name: 'too-short description', body: { description: 'too short' }, code: 'INVALID_DESCRIPTION' },
  ])('EDIT with $name → 400 $code, nothing changes', async ({ body, code }) => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_A.token, transactionId, { action: 'EDIT', ...body });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code });
    expect(await stored(transactionId)).toMatchObject(UNCHANGED);
  });

  it.each([
    {
      name: 'disputedAmount',
      body: { action: 'EDIT', description: NEW_DESCRIPTION, disputedAmount: '10.00' },
    },
    { name: 'an unknown field', body: { action: 'WITHDRAW', priority: 'high' } },
    { name: 'an EDIT that names no field', body: { action: 'EDIT' } },
  ])('body with $name → 400 VALIDATION_FAILED, nothing changes', async ({ body }) => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_A.token, transactionId, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await stored(transactionId)).toMatchObject(UNCHANGED);
  });

  it('EDIT that changes nothing → 200 at the same version, no history, no event', async () => {
    const transactionId = await seed(USER_A.userId);
    const res = await put(svc, USER_A.token, transactionId, { action: 'EDIT', description: DESCRIPTION });

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(await stored(transactionId)).toMatchObject(UNCHANGED);
    expect(await history(transactionId)).toEqual([]);
    expect(eventsFor(svc, transactionId)).toEqual([]);
  });

  it('a failed history insert rolls the update back and publishes nothing', async () => {
    const failing = await startTestService({
      pool: poolFailingOn(db.appPool, 'insert into dispute_status_history'),
      upstreams,
      s3Endpoint: UNUSED_S3,
    });
    try {
      const transactionId = await seed(USER_A.userId);
      const res = await put(failing, USER_A.token, transactionId, { action: 'WITHDRAW' });

      expect(res.statusCode).toBe(500);
      expect(await stored(transactionId)).toMatchObject(UNCHANGED);
      expect(failing.messages).toEqual([]);
    } finally {
      await failing.servers.close();
    }
  });
});

describe('PUT after commit: transactions enrichment never fails the write', () => {
  const isTransactionsLookup = (url: URL) =>
    url.origin === URLS.transactions && url.pathname === '/transactions';

  it.each([
    {
      name: 'a 5xx',
      fault: (url: URL) => (isTransactionsLookup(url) ? Promise.resolve(json(503, {})) : undefined),
    },
    {
      name: 'hanging',
      fault: (url: URL, _body: string, init?: RequestInit) =>
        isTransactionsLookup(url) ? hang(url, init) : undefined,
    },
  ])('transactions $name → 200 with transaction: null and the write committed', async ({ fault }) => {
    const degraded = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3, fault });
    try {
      const transactionId = await seed(USER_A.userId);
      const res = await put(degraded, USER_A.token, transactionId, { action: 'WITHDRAW' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'WITHDRAWN', version: 2, transaction: null });
      expect(await stored(transactionId)).toMatchObject({ status: 'WITHDRAWN', version: 2 });
      expect(await history(transactionId)).toHaveLength(1);
    } finally {
      await degraded.servers.close();
    }
  });

  it('a findTransaction that throws → ok with transaction: null and the write committed', async () => {
    const transactionId = await seed(USER_A.userId);
    const result = await updateDispute({
      transact: createDisputeRepo(db.appPool).transact,
      findTransaction: () => Promise.reject(new Error('boom')),
      publish: async () => undefined,
      newId: randomUUID,
    })({
      userId: USER_A.userId,
      transactionId,
      expectedVersion: 1,
      action: { type: 'WITHDRAW' },
      correlationId: 'test-correlation-id',
    });

    expect(result).toMatchObject({ ok: true, value: { status: 'WITHDRAWN', version: 2, transaction: null } });
    expect(await stored(transactionId)).toMatchObject({ status: 'WITHDRAWN', version: 2 });
    expect(await history(transactionId)).toHaveLength(1);
  });
});
