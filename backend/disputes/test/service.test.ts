import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import {
  createFakeUpstreams,
  SERVICE_CALLER,
  URLS,
  USER_A,
  USER_B,
  WRONG_SCOPE_CALLER,
  type FakeUpstreams,
} from './helpers/fakes.ts';
import { seedDispute } from './helpers/seed.ts';
import { startTestService, type TestService } from './helpers/service.ts';

// The lookup never signs uploads, so S3 is never contacted.
const UNUSED_S3 = 'http://127.0.0.1:1';

let db: TestDb;
let upstreams: FakeUpstreams;
let svc: TestService;
const outbound: URL[] = [];

const lookup = (token: string, query: Readonly<Record<string, string>>) =>
  svc.servers.service.inject({
    method: 'GET',
    url: `/disputes?${new URLSearchParams(query).toString()}`,
    headers: { authorization: `Bearer ${token}` },
  });

const seed = async (userId: string, status: 'SUBMITTED' | 'WITHDRAWN' = 'SUBMITTED', version = 1) => {
  const transactionId = randomUUID();
  const { disputeId } = await seedDispute(db, { userId, transactionId, status, version });
  return { transactionId, disputeId, version };
};

beforeAll(async () => {
  db = await startDisputesDb();
  upstreams = createFakeUpstreams();
  svc = await startTestService({
    pool: db.appPool,
    upstreams,
    s3Endpoint: UNUSED_S3,
    // The service port must never call out (no transactions ↔ disputes loop), so any s2s call fails the test.
    fault: (url) => {
      if (url.origin === URLS.transactions || url.origin === URLS.users) {
        outbound.push(url);
        throw new Error(`unexpected outbound call to ${url.href}`);
      }
      return undefined;
    },
  });
});

afterAll(async () => {
  await svc?.servers.close();
  await db?.stop();
});

describe('GET :8081/disputes', () => {
  it("returns only that user's disputes for the given ids, in the shape transactions parses, with no s2s calls", async () => {
    const submitted = await seed(USER_A.userId);
    const withdrawn = await seed(USER_A.userId, 'WITHDRAWN', 3);
    const othersDispute = await seed(USER_B.userId);

    const res = await lookup(SERVICE_CALLER.token, {
      userId: USER_A.userId,
      transactionIds: [submitted, withdrawn, othersDispute]
        .map((d) => d.transactionId)
        .concat(randomUUID())
        .join(','),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: ReadonlyArray<Record<string, unknown>> }>();
    expectContract('lookup', body);
    expect(Object.keys(body)).toEqual(['items']);
    expect(
      [...body.items].sort((a, b) => String(a.transactionId).localeCompare(String(b.transactionId))),
    ).toEqual(
      [
        { ...submitted, status: 'SUBMITTED' },
        { ...withdrawn, status: 'WITHDRAWN' },
      ].sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
    );
    expect(outbound).toEqual([]);
  });

  it('100 ids → 200; 101 ids → 400', async () => {
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID()).join(',');
    expect(
      (await lookup(SERVICE_CALLER.token, { userId: USER_A.userId, transactionIds: ids(100) })).statusCode,
    ).toBe(200);
    const over = await lookup(SERVICE_CALLER.token, { userId: USER_A.userId, transactionIds: ids(101) });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('needs a service token with disputes/read: another scope → 403, a user token → 403', async () => {
    const query = { userId: USER_A.userId, transactionIds: randomUUID() };
    expect((await lookup(WRONG_SCOPE_CALLER.token, query)).statusCode).toBe(403);
    expect((await lookup(USER_A.token, query)).statusCode).toBe(403);
  });
});
