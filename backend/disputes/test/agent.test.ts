import { randomUUID } from 'node:crypto';
import { parseDisputeEvent } from '@cd/dispute-domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewQueueParams, reviewQueueSql } from '../src/adapters/dispute-repo.ts';
import type { Infra } from '../src/main.ts';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import { AGENT_A, AGENT_B, createFakeUpstreams, URLS, USER_A, type FakeUpstreams } from './helpers/fakes.ts';
import { seedDispute, seedEvidence, seedHistory } from './helpers/seed.ts';
import { startTestService, type TestService } from './helpers/service.ts';

// Agent routes never sign uploads, so S3 is never contacted.
const UNUSED_S3 = 'http://127.0.0.1:1';
const NOTE = 'Merchant confirmed the duplicate charge; refunded.';

type Status = 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'WITHDRAWN';

let db: TestDb;
let upstreams: FakeUpstreams;
let svc: TestService;

const get = (service: TestService, token: string, url: string) =>
  service.servers.public.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const put = (
  service: TestService,
  token: string,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  service.servers.public.inject({
    method: 'PUT',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload),
  });

const detail = (transactionId: string, service = svc) =>
  get(service, AGENT_A.token, `/agent/disputes/${transactionId}`);

const review = (transactionId: string, body: unknown, token = AGENT_A.token, service = svc) =>
  put(service, token, `/agent/disputes/${transactionId}/review`, body);

const resolve = (transactionId: string, body: unknown, token = AGENT_A.token, service = svc) =>
  put(service, token, `/agent/disputes/${transactionId}/resolution`, body);

const seed = async (status: Status = 'SUBMITTED', version = 1, createdAt?: string) => {
  const txn = upstreams.addTransaction(USER_A.userId);
  const seeded = await seedDispute(db, {
    userId: USER_A.userId,
    transactionId: txn.transactionId,
    status,
    version,
    ...(createdAt === undefined ? {} : { createdAt }),
  });
  return { ...seeded, transactionId: txn.transactionId };
};

// Reads the digest from the agent detail, as a client does, so the check is proven to match the read.
const viewOf = async (transactionId: string) => {
  const body = (await detail(transactionId)).json<{ version: number; evidenceDigest: string }>();
  return { expectedVersion: body.version, expectedEvidenceDigest: body.evidenceDigest };
};

const stored = async (transactionId: string) =>
  (
    await db.appQuery(
      `select status, version, resolution_note, resolved_at is not null as resolved, updated_by
       from dispute where transaction_id = $1`,
      [transactionId],
    )
  ).rows[0] as Record<string, unknown>;

const history = async (transactionId: string) =>
  (
    await db.appQuery(
      `select h.action, h.from_status, h.to_status, h.actor_type, h.actor_id, h.note
       from dispute_status_history h join dispute d on d.id = h.dispute_id
       where d.transaction_id = $1 order by h.id`,
      [transactionId],
    )
  ).rows;

const eventsFor = (service: TestService, transactionId: string) =>
  service.messages
    .filter((m) => m.body.includes(transactionId))
    .map((m) => parseDisputeEvent(JSON.parse(m.body)));

type PlanNode = {
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Sort Key'?: ReadonlyArray<string>;
  readonly Plans?: ReadonlyArray<PlanNode>;
};

const nodesOf = (node: PlanNode | undefined): ReadonlyArray<PlanNode> =>
  node === undefined ? [] : [node, ...(node.Plans ?? []).flatMap(nodesOf)];

beforeAll(async () => {
  db = await startDisputesDb();
  upstreams = createFakeUpstreams();
  svc = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3 });
});

afterAll(async () => {
  await svc?.servers.close();
  await db?.stop();
});

describe('token kinds on the public port (one central test each)', () => {
  it('a customer token on /agent/* → 403', async () => {
    expect((await get(svc, USER_A.token, '/agent/review-queue')).statusCode).toBe(403);
  });

  it('an agent token on a customer route → 403', async () => {
    const { transactionId } = await seed();
    expect((await get(svc, AGENT_A.token, `/dispute/${transactionId}`)).statusCode).toBe(403);
  });
});

describe('GET /agent/review-queue', () => {
  // Older than anything else this file seeds, so these rows are the head of the queue.
  const ancient = (minute: number) => `2001-01-01T00:0${minute}:00.000000Z`;

  it('pages oldest first across both open statuses, skips terminal ones, shows who picked up, no customer data', async () => {
    const a = await seed('SUBMITTED', 1, ancient(1));
    const b = await seed('UNDER_REVIEW', 2, ancient(2));
    await seedHistory(db, b.rowId, {
      action: 'REVIEW',
      fromStatus: 'SUBMITTED',
      toStatus: 'UNDER_REVIEW',
      actorType: 'AGENT',
      actorId: AGENT_B.agentId,
      createdAt: ancient(3),
    });
    await seed('WITHDRAWN', 2, ancient(3));
    await seed('RESOLVED_ACCEPTED', 2, ancient(4));
    const c = await seed('SUBMITTED', 1, ancient(5));

    const first = await get(svc, AGENT_A.token, '/agent/review-queue?limit=2');
    expect(first.statusCode).toBe(200);
    expectContract('reviewQueue', first.json());
    const page1 = first.json<{ items: Array<Record<string, unknown>>; nextCursor: string }>();
    expect(page1.items).toEqual([
      {
        disputeId: a.disputeId,
        transactionId: a.transactionId,
        status: 'SUBMITTED',
        reasonCode: 'FRAUD',
        version: 1,
        createdAt: '2001-01-01T00:01:00.000Z',
        pickedUpBy: null,
      },
      expect.objectContaining({
        transactionId: b.transactionId,
        status: 'UNDER_REVIEW',
        pickedUpBy: 'Pieter V.',
      }),
    ]);
    expect(JSON.stringify(page1)).not.toContain(USER_A.userId);

    const second = await get(svc, AGENT_A.token, `/agent/review-queue?limit=2&cursor=${page1.nextCursor}`);
    expect(second.json<{ items: Array<{ transactionId: string }> }>().items[0]?.transactionId).toBe(
      c.transactionId,
    );

    const submittedOnly = await get(svc, AGENT_A.token, '/agent/review-queue?status=SUBMITTED&limit=2');
    expect(
      submittedOnly.json<{ items: Array<{ transactionId: string }> }>().items.map((i) => i.transactionId),
    ).toEqual([a.transactionId, c.transactionId]);
  });

  it('the exact repository query, with bound parameters, is served in order by dispute_review_queue_idx', async () => {
    const client: pg.PoolClient = await db.appPool.connect();
    try {
      await client.query('begin');
      // Tiny test tables favour other plans; with sorting priced out only an ordered index can win, and only if usable.
      await client.query('set local enable_seqscan = off');
      await client.query('set local enable_sort = off');
      for (const after of [null, { createdAt: '2001-01-01T00:00:00.000000Z', rowId: '1' }]) {
        const res = await client.query(`explain (format json) ${reviewQueueSql(after !== null)}`, [
          ...reviewQueueParams({ statuses: ['SUBMITTED'], after, limit: 26 }),
        ]);
        const plan = res.rows[0] as { 'QUERY PLAN': ReadonlyArray<{ Plan: PlanNode }> };
        const nodes = nodesOf(plan['QUERY PLAN'][0]?.Plan);
        expect(nodes.filter((n) => n['Relation Name'] === 'dispute').map((n) => n['Index Name'])).toEqual([
          'dispute_review_queue_idx',
        ]);
        expect(nodes.filter((n) => n['Sort Key']?.includes('d.created_at'))).toEqual([]);
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('GET /agent/disputes/{transactionId}', () => {
  it('returns the dispute with timeline, evidence, digest and the owner-scoped transaction, and logs one view line', async () => {
    const d = await seed('UNDER_REVIEW', 2);
    const evidenceId = await seedEvidence(db, d, {
      fileName: 'receipt.pdf',
      status: 'REJECTED',
      rejectionReason: 'MALWARE',
    });
    await seedHistory(db, d.rowId, {
      action: 'CREATE',
      fromStatus: null,
      toStatus: 'SUBMITTED',
      actorType: 'USER',
      actorId: USER_A.userId,
      createdAt: '2026-10-01T08:00:00Z',
    });
    await seedHistory(db, d.rowId, {
      action: 'EVIDENCE_REJECTED',
      fromStatus: 'SUBMITTED',
      toStatus: 'SUBMITTED',
      actorType: 'SYSTEM_RULE',
      actorId: 'evidence-intake',
      createdAt: '2026-10-01T08:01:00Z',
      after: { evidenceId },
    });
    await seedHistory(db, d.rowId, {
      action: 'REVIEW',
      fromStatus: 'SUBMITTED',
      toStatus: 'UNDER_REVIEW',
      actorType: 'AGENT',
      actorId: AGENT_A.agentId,
      createdAt: '2026-10-01T08:02:00Z',
    });
    const callsBefore = upstreams.calls.length;

    const res = await detail(d.transactionId);
    expect(res.statusCode).toBe(200);
    expectContract('agentDetail', res.json());
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      disputeId: d.disputeId,
      status: 'UNDER_REVIEW',
      version: 2,
      pickedUpBy: 'Naledi M.',
      transaction: { amount: '125.50', merchantName: 'Corner Cafe' },
      evidence: [{ evidenceId, fileName: 'receipt.pdf', status: 'REJECTED', rejectionReason: 'MALWARE' }],
      timeline: [
        { type: 'SUBMITTED', by: 'CUSTOMER' },
        { type: 'EVIDENCE_REJECTED', by: 'SYSTEM', detail: { fileName: 'receipt.pdf', reason: 'MALWARE' } },
        { type: 'UNDER_REVIEW', by: 'AGENT', agentName: 'Naledi M.' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(USER_A.userId);

    const txnCalls = upstreams.calls.slice(callsBefore).filter((c) => c.url.origin === URLS.transactions);
    expect(txnCalls.map((c) => c.url.searchParams.get('userId'))).toEqual([USER_A.userId]);

    const viewed = svc
      .logLines()
      .filter((l) => l.msg === 'agent dispute viewed' && l.disputeId === d.disputeId);
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ agentId: AGENT_A.agentId, disputeId: d.disputeId });
    expect(JSON.stringify(viewed[0])).not.toContain(USER_A.userId);
  });

  it('AGENT actors with a non-uuid or unknown id get no name; transactions or the name source down → still 200', async () => {
    const failing: Infra['resolveAgentNames'] = () => Promise.reject(new Error('directory down'));
    const degraded = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: UNUSED_S3,
      fault: (url) => (url.origin === URLS.transactions ? Promise.reject(new Error('down')) : undefined),
      resolveAgentNames: failing,
    });
    try {
      const d = await seed('UNDER_REVIEW', 2);
      await seedHistory(db, d.rowId, {
        action: 'REVIEW',
        fromStatus: 'SUBMITTED',
        toStatus: 'UNDER_REVIEW',
        actorType: 'AGENT',
        actorId: 'legacy-console',
        createdAt: '2026-10-01T08:02:00Z',
      });
      const viaDegraded = await detail(d.transactionId, degraded);
      expect(viaDegraded.statusCode).toBe(200);
      expectContract('agentDetail', viaDegraded.json());
      expect(viaDegraded.json()).toMatchObject({ transaction: null, pickedUpBy: null });

      const viaNormal = await detail(d.transactionId);
      expect(viaNormal.json()).toMatchObject({
        pickedUpBy: null,
        timeline: [{ type: 'UNDER_REVIEW', by: 'AGENT' }],
      });
      expect(viaNormal.json<{ timeline: Array<Record<string, unknown>> }>().timeline[0]).not.toHaveProperty(
        'agentName',
      );
    } finally {
      await degraded.servers.close();
    }
  });

  it('unknown transaction → 404', async () => {
    expect((await detail(randomUUID())).statusCode).toBe(404);
  });
});

describe('PUT /agent/disputes/{transactionId}/review', () => {
  it('SUBMITTED → UNDER_REVIEW with AGENT history, version bump, and DisputeStatusChanged published after commit', async () => {
    const d = await seed();
    const view = await viewOf(d.transactionId);
    const statusAtPublish: unknown[] = [];
    const observing = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: UNUSED_S3,
      // Another connection reads at send time, so it only sees the change if the transaction already committed.
      send: async (m) => {
        if (m.body.includes(d.transactionId)) {
          statusAtPublish.push((await stored(d.transactionId)).status);
        }
      },
    });
    try {
      const res = await review(d.transactionId, view, AGENT_A.token, observing);
      expect(res.statusCode).toBe(200);
      expectContract('agentDetail', res.json());
      expect(res.json()).toMatchObject({ status: 'UNDER_REVIEW', version: 2, pickedUpBy: 'Naledi M.' });
      expect(statusAtPublish).toEqual(['UNDER_REVIEW']);
    } finally {
      await observing.servers.close();
    }
    expect(await stored(d.transactionId)).toMatchObject({
      status: 'UNDER_REVIEW',
      version: 2,
      updated_by: `AGENT:${AGENT_A.agentId}`,
    });
    expect(await history(d.transactionId)).toEqual([
      {
        action: 'REVIEW',
        from_status: 'SUBMITTED',
        to_status: 'UNDER_REVIEW',
        actor_type: 'AGENT',
        actor_id: AGENT_A.agentId,
        note: null,
      },
    ]);
  });

  it('publishes exactly one DisputeStatusChanged with ids only', async () => {
    const d = await seed();
    await review(d.transactionId, await viewOf(d.transactionId));
    expect(eventsFor(svc, d.transactionId)).toEqual([
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          eventType: 'DisputeStatusChanged',
          userId: USER_A.userId,
          version: 2,
          data: { fromStatus: 'SUBMITTED', toStatus: 'UNDER_REVIEW', reasonCode: 'FRAUD' },
        }),
      }),
    ]);
  });

  it('a second agent replaying with the same view → 200 with the stored state; a view older than the pick-up → 412', async () => {
    const d = await seed('SUBMITTED', 2);
    const view = await viewOf(d.transactionId);
    expect((await review(d.transactionId, view)).statusCode).toBe(200);

    const replay = await review(d.transactionId, view, AGENT_B.token);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'UNDER_REVIEW', version: 3, pickedUpBy: 'Naledi M.' });

    const older = await review(d.transactionId, { ...view, expectedVersion: 1 }, AGENT_B.token);
    expect(older.statusCode).toBe(412);
    expect(older.json()).toMatchObject({ code: 'STALE_VERSION' });
    expect(await history(d.transactionId)).toHaveLength(1);
    expect(eventsFor(svc, d.transactionId)).toHaveLength(1);
  });

  it('stale expectedVersion → 412 STALE_VERSION, nothing written', async () => {
    const d = await seed('SUBMITTED', 3);
    const view = await viewOf(d.transactionId);
    const res = await review(d.transactionId, { ...view, expectedVersion: 2 });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'STALE_VERSION' });
    expect(await stored(d.transactionId)).toMatchObject({ status: 'SUBMITTED', version: 3 });
  });

  it('evidence settled since the read → 412 STALE_EVIDENCE, nothing written', async () => {
    const d = await seed();
    const evidenceId = await seedEvidence(db, d, { fileName: 'a.pdf', status: 'PENDING' });
    const view = await viewOf(d.transactionId);
    await db.appQuery(
      "update dispute_evidence set status = 'STORED', s3_key = $2, stored_at = now() where evidence_id = $1",
      [evidenceId, `evidence/${d.disputeId}/${evidenceId}`],
    );
    const res = await review(d.transactionId, view);
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(await stored(d.transactionId)).toMatchObject({ status: 'SUBMITTED', version: 1 });
    expect(await history(d.transactionId)).toEqual([]);
  });

  it('withdrawn → 409 INVALID_TRANSITION; unknown → 404', async () => {
    const d = await seed('WITHDRAWN', 2);
    const res = await review(d.transactionId, await viewOf(d.transactionId));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(
      (await review(randomUUID(), { expectedVersion: 1, expectedEvidenceDigest: 'a'.repeat(64) })).statusCode,
    ).toBe(404);
  });
});

describe('PUT /agent/disputes/{transactionId}/resolution', () => {
  it('UNDER_REVIEW → RESOLVED_ACCEPTED sets resolved_at and the note, writes AGENT history, publishes', async () => {
    const d = await seed('UNDER_REVIEW', 2);
    const res = await resolve(d.transactionId, {
      ...(await viewOf(d.transactionId)),
      outcome: 'ACCEPTED',
      note: NOTE,
    });
    expect(res.statusCode).toBe(200);
    expectContract('agentDetail', res.json());
    expect(res.json()).toMatchObject({
      status: 'RESOLVED_ACCEPTED',
      version: 3,
      resolutionNote: NOTE,
      timeline: [{ type: 'RESOLVED_ACCEPTED', by: 'AGENT', agentName: 'Naledi M.', detail: { note: NOTE } }],
    });
    expect(await stored(d.transactionId)).toMatchObject({
      status: 'RESOLVED_ACCEPTED',
      resolved: true,
      resolution_note: NOTE,
    });
    expect(await history(d.transactionId)).toEqual([
      {
        action: 'RESOLVE',
        from_status: 'UNDER_REVIEW',
        to_status: 'RESOLVED_ACCEPTED',
        actor_type: 'AGENT',
        actor_id: AGENT_A.agentId,
        note: NOTE,
      },
    ]);
    expect(eventsFor(svc, d.transactionId).map((e) => e.ok && e.value.data)).toEqual([
      { fromStatus: 'UNDER_REVIEW', toStatus: 'RESOLVED_ACCEPTED', reasonCode: 'FRAUD' },
    ]);
  });

  it('same-outcome replay → 200 keeping the first note; the other outcome → 409', async () => {
    const d = await seed();
    const view = await viewOf(d.transactionId);
    expect((await resolve(d.transactionId, { ...view, outcome: 'REJECTED', note: NOTE })).statusCode).toBe(
      200,
    );

    const replay = await resolve(
      d.transactionId,
      { ...view, outcome: 'REJECTED', note: 'A different note entirely.' },
      AGENT_B.token,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'RESOLVED_REJECTED', resolutionNote: NOTE });

    const flip = await resolve(d.transactionId, { ...view, outcome: 'ACCEPTED', note: NOTE });
    expect(flip.statusCode).toBe(409);
    expect(flip.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await stored(d.transactionId)).toMatchObject({
      status: 'RESOLVED_REJECTED',
      resolution_note: NOTE,
      version: 2,
    });
    expect(await history(d.transactionId)).toHaveLength(1);
    expect(eventsFor(svc, d.transactionId)).toHaveLength(1);
  });

  it('evidence declared since the read → 412 STALE_EVIDENCE', async () => {
    const d = await seed('UNDER_REVIEW', 2);
    const view = await viewOf(d.transactionId);
    await seedEvidence(db, d, { fileName: 'late.pdf', status: 'PENDING' });
    const res = await resolve(d.transactionId, { ...view, outcome: 'ACCEPTED', note: NOTE });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(await stored(d.transactionId)).toMatchObject({ status: 'UNDER_REVIEW', resolution_note: null });
  });
});

describe('withdraw vs resolve race: the first commit wins', () => {
  // Holds the first transaction that writes history until released, with its dispute row lock held.
  const gatedPool = (pool: pg.Pool) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => undefined;
    const holding = new Promise<void>((r) => {
      reached = r;
    });
    let armed = true;
    const wrapped = {
      query: pool.query.bind(pool),
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
                if (armed && typeof sql === 'string' && sql.includes('insert into dispute_status_history')) {
                  armed = false;
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
    } as unknown as Infra['pool'];
    return { pool: wrapped, holding, release: () => release() };
  };

  const waitForLockWaiter = async (): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      const res = await db.appQuery(
        "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%for update%'",
      );
      if ((res.rows[0] as { n: number }).n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('second writer never blocked on the row lock');
  };

  it('customer withdraw commits first → the agent resolve gets 409 and writes nothing', async () => {
    const d = await seed('UNDER_REVIEW', 2);
    const view = await viewOf(d.transactionId);
    const gated = gatedPool(db.appPool);
    const customer = await startTestService({ pool: gated.pool, upstreams, s3Endpoint: UNUSED_S3 });
    try {
      const withdraw = put(
        customer,
        USER_A.token,
        `/dispute/${d.transactionId}`,
        { action: 'WITHDRAW' },
        { 'if-match': '"2"' },
      );
      await gated.holding;
      const agent = resolve(d.transactionId, { ...view, outcome: 'ACCEPTED', note: NOTE });
      await waitForLockWaiter();
      gated.release();
      const [w, a] = await Promise.all([withdraw, agent]);
      expect(w.statusCode).toBe(200);
      expect(a.statusCode).toBe(409);
      expect(await stored(d.transactionId)).toMatchObject({
        status: 'WITHDRAWN',
        version: 3,
        resolution_note: null,
      });
      expect((await history(d.transactionId)).map((h) => h.action)).toEqual(['WITHDRAW']);
    } finally {
      await customer.servers.close();
    }
  });

  it('agent resolve commits first → the customer withdraw is refused and writes nothing', async () => {
    const d = await seed('UNDER_REVIEW', 2);
    const view = await viewOf(d.transactionId);
    const gated = gatedPool(db.appPool);
    const agentSvc = await startTestService({ pool: gated.pool, upstreams, s3Endpoint: UNUSED_S3 });
    try {
      const agent = resolve(
        d.transactionId,
        { ...view, outcome: 'ACCEPTED', note: NOTE },
        AGENT_A.token,
        agentSvc,
      );
      await gated.holding;
      const withdraw = put(
        svc,
        USER_A.token,
        `/dispute/${d.transactionId}`,
        { action: 'WITHDRAW' },
        { 'if-match': '"2"' },
      );
      await waitForLockWaiter();
      gated.release();
      const [a, w] = await Promise.all([agent, withdraw]);
      expect(a.statusCode).toBe(200);
      // The customer path checks If-Match first, so the loser sees 412 (docs/02).
      expect(w.statusCode).toBe(412);
      expect(await stored(d.transactionId)).toMatchObject({ status: 'RESOLVED_ACCEPTED', version: 3 });
      expect((await history(d.transactionId)).map((h) => h.action)).toEqual(['RESOLVE']);
    } finally {
      await agentSvc.servers.close();
    }
  });
});
