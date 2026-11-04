import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { inNetwork, sentEmails, sha256Hex, until, type SentEmail } from '../src/async.ts';
import {
  agentToken,
  call,
  freshDisputable,
  serviceToken,
  URLS,
  userToken,
  type Json,
  type Reply,
} from '../src/stack.ts';

const AGENT_NAME = 'Naledi M.';
const ACCEPTED_SUBJECT = 'Your dispute was resolved in your favour';
const REJECTED_SUBJECT = 'Your dispute has been resolved';

let tokenA: string;
let agentE: string;
let contactEmailA: string;

const newDispute = async (label: string): Promise<{ readonly disputeId: string; readonly transactionId: string }> => {
  const target = await freshDisputable(tokenA);
  const reply = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}`, {
    token: tokenA,
    body: { reasonCode: 'NOT_RECEIVED', description: `e2e back office ${label} ${new Date().toISOString()}` },
  });
  expect(reply.status).toBe(201);
  return { disputeId: reply.body['disputeId'], transactionId: target.transactionId };
};

const agentDetail = async (transactionId: string, token = agentE): Promise<Json> => {
  const reply = await call('GET', `${URLS.disputes}/agent/disputes/${transactionId}`, { token });
  expect(reply.status).toBe(200);
  return reply.body;
};

const expectedOf = (detail: Json) => ({
  expectedVersion: detail['version'],
  expectedEvidenceDigest: detail['evidenceDigest'],
});

const pickUp = (transactionId: string, expected: Json, token = agentE): Promise<Reply> =>
  call('PUT', `${URLS.disputes}/agent/disputes/${transactionId}/review`, { token, body: expected });

const resolve = (
  transactionId: string,
  decision: { readonly outcome: 'ACCEPTED' | 'REJECTED'; readonly note: string },
  expected: Json,
  token = agentE,
): Promise<Reply> =>
  call('PUT', `${URLS.disputes}/agent/disputes/${transactionId}/resolution`, { token, body: { ...decision, ...expected } });

const customerView = async (transactionId: string): Promise<Reply> =>
  call('GET', `${URLS.disputes}/dispute/${transactionId}`, { token: tokenA });

const findInQueue = async (disputeId: string, status: string): Promise<{ item: Json | undefined; seen: Json[] }> => {
  const seen: Json[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ status, limit: '100', ...(cursor !== null ? { cursor } : {}) });
    const page: Reply = await call('GET', `${URLS.disputes}/agent/review-queue?${params}`, { token: agentE });
    expect(page.status).toBe(200);
    seen.push(...page.body['items']);
    const item = page.body['items'].find((candidate: Json) => candidate['disputeId'] === disputeId);
    if (item !== undefined) return { item, seen };
    cursor = page.body['nextCursor'];
  } while (cursor !== null);
  return { item: undefined, seen };
};

const mailsFor = async (disputeId: string): Promise<readonly SentEmail[]> =>
  (await sentEmails()).filter((mail) => mail.text.includes(disputeId));

beforeAll(async () => {
  [tokenA, agentE] = await Promise.all([userToken('A'), agentToken('E')]);
  const me = (await call('GET', `${URLS.users}/me`, { token: tokenA })).body;
  const notifier = await serviceToken('svc-notifier');
  contactEmailA = inNetwork('users', 'GET', `/users/${me['userId']}/contact`, { token: notifier }).body['email'];
}, 60_000);

describe('M5 outcome: an agent works the queue and the customer sees the outcome', () => {
  const ACCEPT_NOTE = `Refund approved after review ${randomUUID()}`;
  const REJECT_NOTE = `The merchant showed proof of delivery ${randomUUID()}`;
  let accepted: { disputeId: string; transactionId: string };
  let rejected: { disputeId: string; transactionId: string };

  beforeAll(async () => {
    accepted = await newDispute('accept');
    rejected = await newDispute('reject');
  }, 60_000);

  it('the queue lists the new dispute oldest first, with no customer identifiers', async () => {
    const { item, seen } = await findInQueue(accepted.disputeId, 'SUBMITTED');
    expect(item).toMatchObject({
      disputeId: accepted.disputeId,
      transactionId: accepted.transactionId,
      status: 'SUBMITTED',
      reasonCode: 'NOT_RECEIVED',
      version: 1,
      pickedUpBy: null,
    });
    for (const entry of seen) {
      expect(Object.keys(entry).sort()).toEqual(
        ['createdAt', 'disputeId', 'pickedUpBy', 'reasonCode', 'status', 'transactionId', 'version'].sort(),
      );
    }
    const created = seen.map((entry) => Date.parse(entry['createdAt']));
    expect(created).toEqual([...created].sort((a, b) => a - b));
  });

  it('picking up moves both disputes to UNDER_REVIEW under the agent name', async () => {
    for (const target of [accepted, rejected]) {
      const reply = await pickUp(target.transactionId, expectedOf(await agentDetail(target.transactionId)));
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ status: 'UNDER_REVIEW', version: 2, pickedUpBy: AGENT_NAME });
    }
    const { item } = await findInQueue(accepted.disputeId, 'UNDER_REVIEW');
    expect(item).toMatchObject({ status: 'UNDER_REVIEW', pickedUpBy: AGENT_NAME });
  });

  it('resolves one ACCEPTED and one REJECTED with a note', async () => {
    const yes = await resolve(
      accepted.transactionId,
      { outcome: 'ACCEPTED', note: ACCEPT_NOTE },
      expectedOf(await agentDetail(accepted.transactionId)),
    );
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ status: 'RESOLVED_ACCEPTED', resolutionNote: ACCEPT_NOTE, resolvedAt: expect.any(String) });

    const no = await resolve(
      rejected.transactionId,
      { outcome: 'REJECTED', note: REJECT_NOTE },
      expectedOf(await agentDetail(rejected.transactionId)),
    );
    expect(no.status).toBe(200);
    expect(no.body).toMatchObject({ status: 'RESOLVED_REJECTED', resolutionNote: REJECT_NOTE });

    expect((await findInQueue(accepted.disputeId, 'UNDER_REVIEW')).item).toBeUndefined();
  });

  it('the customer sees status and note on the timeline, attributed to BANK with no agent identity', async () => {
    for (const [target, status, note] of [
      [accepted, 'RESOLVED_ACCEPTED', ACCEPT_NOTE],
      [rejected, 'RESOLVED_REJECTED', REJECT_NOTE],
    ] as const) {
      const reply = await customerView(target.transactionId);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ status, resolutionNote: note });
      const timeline: Json[] = reply.body['timeline'];
      expect(timeline.map((event) => event['type'])).toEqual(['SUBMITTED', 'UNDER_REVIEW', status]);
      expect(timeline[1]).toMatchObject({ by: 'BANK' });
      expect(timeline[2]).toMatchObject({ by: 'BANK', detail: { note } });
      const raw = JSON.stringify(reply.body);
      expect(raw).not.toContain(AGENT_NAME);
      expect(raw).not.toContain('agentName');
      expect(raw).not.toContain('pickedUpBy');
    }
  });

  it('the notifier emails each final status to the owner only', async () => {
    for (const [target, subject] of [
      [accepted, ACCEPTED_SUBJECT],
      [rejected, REJECTED_SUBJECT],
    ] as const) {
      await until(`"${subject}" for ${target.disputeId}`, async () =>
        (await mailsFor(target.disputeId)).find((mail) => mail.subject === subject),
      );
      const mails = await mailsFor(target.disputeId);
      for (const mail of mails) expect(mail.to).toEqual([contactEmailA]);
    }
  }, 60_000);

  it('a resolve replay with another note returns 200 and keeps the first note', async () => {
    const before = await agentDetail(accepted.transactionId);
    const replay = await resolve(
      accepted.transactionId,
      { outcome: 'ACCEPTED', note: 'A different note on replay' },
      expectedOf(before),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'RESOLVED_ACCEPTED', resolutionNote: ACCEPT_NOTE, version: before['version'] });
    const customer = await customerView(accepted.transactionId);
    expect(customer.body['resolutionNote']).toBe(ACCEPT_NOTE);
    expect(customer.body['timeline'].filter((event: Json) => event['type'] === 'RESOLVED_ACCEPTED')).toHaveLength(1);
  });

  it('resolving again with the other outcome is 409', async () => {
    const reply = await resolve(
      accepted.transactionId,
      { outcome: 'REJECTED', note: 'Changing my mind after the fact' },
      expectedOf(await agentDetail(accepted.transactionId)),
    );
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await customerView(accepted.transactionId)).body).toMatchObject({ status: 'RESOLVED_ACCEPTED' });
  });
});

describe('M5 outcome: an agent acting on a stale read is refused with 412', () => {
  let target: { disputeId: string; transactionId: string };

  beforeAll(async () => {
    target = await newDispute('stale');
  }, 60_000);

  it('resolving after the customer adds evidence is 412 STALE_EVIDENCE and changes nothing', async () => {
    const read = await agentDetail(target.transactionId);
    const bytes = new TextEncoder().encode(`%PDF-1.4 stale evidence ${randomUUID()}`);
    const declared = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}/evidence`, {
      token: tokenA,
      body: {
        evidence: [{ fileName: 'late-e2e.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256: sha256Hex(bytes) }],
      },
    });
    expect(declared.status).toBe(201);

    const reply = await resolve(target.transactionId, { outcome: 'REJECTED', note: 'Read before the new evidence' }, expectedOf(read));
    expect(reply.status).toBe(412);
    expect(reply.body).toMatchObject({ code: 'STALE_EVIDENCE' });
    expect((await customerView(target.transactionId)).body).toMatchObject({ status: 'SUBMITTED', resolutionNote: null });
  });

  it('picking up after the customer edits is 412 STALE_VERSION', async () => {
    const read = await agentDetail(target.transactionId);
    const current = await customerView(target.transactionId);
    const edited = await call('PUT', `${URLS.disputes}/dispute/${target.transactionId}`, {
      token: tokenA,
      headers: { 'if-match': current.headers.get('etag') ?? '' },
      body: { action: 'EDIT', description: `e2e back office stale edited ${new Date().toISOString()}` },
    });
    expect(edited.status).toBe(200);

    const reply = await pickUp(target.transactionId, expectedOf(read));
    expect(reply.status).toBe(412);
    expect(reply.body).toMatchObject({ code: 'STALE_VERSION' });
  });

  it('a fresh read then succeeds (and leaves the queue clean for the next run)', async () => {
    const reply = await resolve(
      target.transactionId,
      { outcome: 'REJECTED', note: 'Resolved after a fresh read' },
      expectedOf(await agentDetail(target.transactionId)),
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: 'RESOLVED_REJECTED' });
  });
});

describe('M5: agent routes and customer routes refuse each other', () => {
  const UNKNOWN = randomUUID();
  let transactionId: string;
  let service: string;
  let disabledAgent: string;

  beforeAll(async () => {
    [service, disabledAgent] = await Promise.all([serviceToken('svc-notifier'), agentToken('F')]);
    const target = await freshDisputable(tokenA);
    transactionId = target.transactionId;
  }, 60_000);

  const agentCalls = (id: string): ReadonlyArray<readonly [string, string, unknown?]> => [
    ['GET', `${URLS.disputes}/agent/review-queue`],
    ['GET', `${URLS.disputes}/agent/disputes/${id}`],
    ['PUT', `${URLS.disputes}/agent/disputes/${id}/review`, { expectedVersion: 1, expectedEvidenceDigest: '0'.repeat(64) }],
    [
      'PUT',
      `${URLS.disputes}/agent/disputes/${id}/resolution`,
      { outcome: 'ACCEPTED', note: 'Not allowed to do this', expectedVersion: 1, expectedEvidenceDigest: '0'.repeat(64) },
    ],
  ];

  const statuses = async (token: string, id: string): Promise<readonly number[]> =>
    Promise.all(
      agentCalls(id).map(async ([method, url, body]) => (await call(method, url, { token, body })).status),
    );

  it('a customer token on /agent/* is 403', async () => {
    expect(await statuses(tokenA, transactionId)).toEqual([403, 403, 403, 403]);
  });

  it('a service token on /agent/* is 403', async () => {
    expect(await statuses(service, UNKNOWN)).toEqual([403, 403, 403, 403]);
  });

  it('the disabled agent F is 401', async () => {
    expect(await statuses(disabledAgent, UNKNOWN)).toEqual([401, 401, 401, 401]);
  });

  it('an agent token on customer routes of every public service is 403', async () => {
    const results = await Promise.all([
      call('GET', `${URLS.users}/me`, { token: agentE }),
      call('GET', `${URLS.transactions}/transactions`, { token: agentE }),
      call('GET', `${URLS.disputes}/disputes`, { token: agentE }),
      call('GET', `${URLS.disputes}/dispute/${transactionId}`, { token: agentE }),
      call('POST', `${URLS.disputes}/dispute/${transactionId}`, {
        token: agentE,
        body: { reasonCode: 'FRAUD', description: 'An agent may not raise disputes' },
      }),
    ]);
    expect(results.map((reply) => reply.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('the SPA origin proxies /api/agent/ to disputes (nginx), so the agent token works through it', async () => {
    const reply = await call('GET', `${URLS.frontend}/api/agent/review-queue?limit=1`, { token: agentE });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ items: expect.any(Array) });
    expect((await call('GET', `${URLS.frontend}/api/agent/review-queue?limit=1`, { token: tokenA })).status).toBe(403);
  });
});
