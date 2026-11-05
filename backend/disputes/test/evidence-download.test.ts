import { randomUUID } from 'node:crypto';
import type { EvidenceViewRequest } from '@cd/dispute-domain';
import { err, ok } from '@cd/shared/fp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvokeViewer } from '../src/use-cases/ports.ts';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import {
  AGENT_A,
  AGENT_B,
  createFakeUpstreams,
  SERVICE_CALLER,
  USER_A,
  type FakeUpstreams,
} from './helpers/fakes.ts';
import { seedDispute, seedEvidence } from './helpers/seed.ts';
import {
  poolFailingOn,
  poolPausingAfter,
  startTestService,
  type TestService,
  type TestServiceOptions,
} from './helpers/service.ts';

const UNUSED_S3 = 'http://127.0.0.1:1';

type EvidenceStatus = 'PENDING' | 'STORED' | 'REJECTED' | 'EXPIRED' | 'ERASED';

let db: TestDb;
let upstreams: FakeUpstreams;
let viewer: FakeViewer;
let svc: TestService;

type FakeViewer = { readonly requests: EvidenceViewRequest[]; readonly invoke: InvokeViewer };

const fakeViewer = (reply?: InvokeViewer): FakeViewer => {
  const requests: EvidenceViewRequest[] = [];
  return {
    requests,
    invoke: async (request) => {
      requests.push(request);
      if (reply !== undefined) return reply(request);
      return ok({
        url: `https://evidence.test/${randomUUID()}?X-Amz-Signature=deadbeef`,
        expiresAt: '2026-11-05T10:01:00.000Z',
      });
    },
  };
};

const startWith = (options: Partial<TestServiceOptions>) =>
  startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3, ...options });

const seedItem = async (
  status: EvidenceStatus = 'STORED',
  contentType: 'image/png' | 'application/pdf' = 'image/png',
) => {
  const txn = upstreams.addTransaction(USER_A.userId);
  const dispute = await seedDispute(db, { userId: USER_A.userId, transactionId: txn.transactionId });
  const evidenceId = await seedEvidence(db, dispute, {
    fileName: 'receipt-of-jane.png',
    status,
    contentType,
  });
  return { ...dispute, transactionId: txn.transactionId, evidenceId };
};

const download = (
  transactionId: string,
  evidenceId: string,
  token = AGENT_A.token,
  service = svc,
  extra: { readonly query?: string; readonly headers?: Record<string, string> } = {},
) =>
  service.servers.public.inject({
    method: 'GET',
    url: `/agent/disputes/${transactionId}/evidence/${evidenceId}/download${extra.query ?? ''}`,
    headers: { authorization: `Bearer ${token}`, ...extra.headers },
  });

const viewsOf = async (evidenceId: string) =>
  (
    await db.appQuery(
      `select v.agent_id::text as agent_id, v.dispute_id::text as dispute_row_id
       from evidence_view v join dispute_evidence e on e.id = v.evidence_id
       where e.evidence_id = $1 order by v.id`,
      [evidenceId],
    )
  ).rows as Array<{ agent_id: string; dispute_row_id: string }>;

const viewCountOf = async (agentId: string): Promise<number> =>
  (
    (await db.appQuery('select count(*)::int as n from evidence_view where agent_id = $1', [agentId]))
      .rows[0] as {
      n: number;
    }
  ).n;

const seedViews = async (agentId: string, evidenceId: string, ages: ReadonlyArray<string>): Promise<void> => {
  for (const age of ages) {
    await db.appQuery(
      `insert into evidence_view (evidence_id, dispute_id, agent_id, viewed_at)
       select id, dispute_id, $2, now() - $3::interval from dispute_evidence where evidence_id = $1`,
      [evidenceId, agentId, age],
    );
  }
};

beforeAll(async () => {
  db = await startDisputesDb();
  upstreams = createFakeUpstreams();
  viewer = fakeViewer();
  svc = await startWith({ viewer: viewer.invoke });
});

afterAll(async () => {
  await svc?.servers.close();
  await db?.stop();
});

describe('GET /agent/disputes/{transactionId}/evidence/{evidenceId}/download', () => {
  it('200 with the link and no-store; the viewer gets ids, the declared type and the correlation id, never a key; one audit row and one log line', async () => {
    const item = await seedItem('STORED', 'image/png');
    const before = viewer.requests.length;

    const res = await download(item.transactionId, item.evidenceId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectContract('evidenceDownload', res.json());

    const sent = viewer.requests.slice(before);
    expect(sent).toEqual([
      {
        disputeId: item.disputeId,
        evidenceId: item.evidenceId,
        contentType: 'image/png',
        correlationId: res.headers['x-correlation-id'],
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('evidence/');
    expect(await viewsOf(item.evidenceId)).toEqual([
      { agent_id: AGENT_A.agentId, dispute_row_id: item.rowId },
    ]);

    const lines = svc
      .logLines()
      .filter((l) => l.msg === 'agent evidence download' && l.evidenceId === item.evidenceId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentId: AGENT_A.agentId, disputeId: item.disputeId, outcome: 'OK' });
    expect(JSON.stringify(svc.logLines())).not.toContain(res.json<{ url: string }>().url);
  });

  it('the audit agent is the token’s, whatever agent id the request carries', async () => {
    const item = await seedItem();
    const res = await download(item.transactionId, item.evidenceId, AGENT_A.token, svc, {
      query: `?agentId=${AGENT_B.agentId}`,
      headers: { 'x-agent-id': AGENT_B.agentId },
    });
    expect(res.statusCode).toBe(200);
    expect((await viewsOf(item.evidenceId)).map((v) => v.agent_id)).toEqual([AGENT_A.agentId]);
  });

  it('unknown dispute, unknown item and another dispute’s item → the same 404, no row, no invoke', async () => {
    const mine = await seedItem();
    const other = await seedItem();
    const before = viewer.requests.length;
    const cases = [
      [randomUUID(), mine.evidenceId],
      [mine.transactionId, randomUUID()],
      [mine.transactionId, other.evidenceId],
    ] as const;

    const bodies: string[] = [];
    for (const [transactionId, evidenceId] of cases) {
      const res = await download(transactionId, evidenceId);
      expect(res.statusCode).toBe(404);
      bodies.push(JSON.stringify({ ...res.json<Record<string, unknown>>(), correlationId: null }));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(viewer.requests.length).toBe(before);
    expect(await viewsOf(mine.evidenceId)).toEqual([]);
    expect(await viewsOf(other.evidenceId)).toEqual([]);
  });

  it.each(['PENDING', 'REJECTED', 'EXPIRED', 'ERASED'] as const)(
    '%s item → 409 EVIDENCE_NOT_STORED, no row, no invoke',
    async (status) => {
      const item = await seedItem(status);
      const before = viewer.requests.length;
      const res = await download(item.transactionId, item.evidenceId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'EVIDENCE_NOT_STORED' });
      expect(viewer.requests.length).toBe(before);
      expect(await viewsOf(item.evidenceId)).toEqual([]);
    },
  );

  it('rate cap: rows older than the window do not count; at the cap → 429 RATE_LIMITED with Retry-After, no row, no invoke', async () => {
    const agent = upstreams.addAgent();
    const item = await seedItem();
    await seedViews(agent.agentId, item.evidenceId, [
      ...Array.from({ length: 5 }, () => '11 minutes'),
      '9 minutes',
      ...Array.from({ length: 28 }, () => '1 minute'),
    ]);

    expect((await download(item.transactionId, item.evidenceId, agent.token)).statusCode).toBe(200);
    expect(await viewCountOf(agent.agentId)).toBe(35);
    const before = viewer.requests.length;

    const res = await download(item.transactionId, item.evidenceId, agent.token);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'RATE_LIMITED' });
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(55);
    expect(retryAfter).toBeLessThanOrEqual(61);
    expect(await viewCountOf(agent.agentId)).toBe(35);
    expect(viewer.requests.length).toBe(before);
  });

  it('concurrent requests at the cap cannot overshoot it', async () => {
    const agent = upstreams.addAgent();
    const item = await seedItem();
    await seedViews(
      agent.agentId,
      item.evidenceId,
      Array.from({ length: 28 }, () => '1 minute'),
    );
    // Holds every transaction after its count, so without the per-agent lock all five would see 28.
    const racing = await startWith({
      pool: poolPausingAfter(db.appPool, 'from evidence_view', 150),
      viewer: viewer.invoke,
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => download(item.transactionId, item.evidenceId, agent.token, racing)),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 429, 429, 429]);
      expect(await viewCountOf(agent.agentId)).toBe(30);
    } finally {
      await racing.servers.close();
    }
  });

  it('the audit row is committed before the invoke and stands when the viewer fails → 503 VIEWER_UNAVAILABLE', async () => {
    const item = await seedItem();
    const committedAtInvoke: number[] = [];
    const failing = fakeViewer(async () => {
      committedAtInvoke.push((await viewsOf(item.evidenceId)).length);
      return err('VIEWER_UNAVAILABLE');
    });
    const service = await startWith({ viewer: failing.invoke });
    try {
      const res = await download(item.transactionId, item.evidenceId, AGENT_A.token, service);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'VIEWER_UNAVAILABLE' });
      expect(committedAtInvoke).toEqual([1]);
      expect(await viewsOf(item.evidenceId)).toHaveLength(1);
    } finally {
      await service.servers.close();
    }
  });

  it('audit insert fails → 503 and the viewer is never invoked (fail closed)', async () => {
    const item = await seedItem();
    const watched = fakeViewer();
    const service = await startWith({
      pool: poolFailingOn(db.appPool, 'insert into evidence_view'),
      viewer: watched.invoke,
    });
    try {
      const res = await download(item.transactionId, item.evidenceId, AGENT_A.token, service);
      expect(res.statusCode).toBe(503);
      expect(watched.requests).toEqual([]);
      expect(await viewsOf(item.evidenceId)).toEqual([]);
    } finally {
      await service.servers.close();
    }
  });

  it('no viewer configured → 503 VIEWER_UNAVAILABLE', async () => {
    const item = await seedItem();
    const service = await startWith({});
    try {
      const res = await download(item.transactionId, item.evidenceId, AGENT_A.token, service);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'VIEWER_UNAVAILABLE' });
    } finally {
      await service.servers.close();
    }
  });

  it.each([
    ['customer', USER_A.token],
    ['service', SERVICE_CALLER.token],
  ])('a %s token → 403, no row, no invoke', async (_kind, token) => {
    const item = await seedItem();
    const before = viewer.requests.length;
    expect((await download(item.transactionId, item.evidenceId, token)).statusCode).toBe(403);
    expect(viewer.requests.length).toBe(before);
    expect(await viewsOf(item.evidenceId)).toEqual([]);
  });
});
