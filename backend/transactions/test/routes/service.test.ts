import { zLookupTransactionsResponse } from '@cd/contracts/transactions.service';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_URL,
  TOKEN_URL,
  buildHarness,
  expectContract,
  fakeId,
  seed,
  serviceToken,
  startTestDb,
  userToken,
  type Harness,
  type SeedRow,
  type TestDb,
  type Upstream,
} from '../helpers.ts';

const A = fakeId(1, 1);
const B = fakeId(1, 2);
const A1 = fakeId(2, 1);
const A2 = fakeId(2, 2);
const B1 = fakeId(2, 3);
const CARD_A1 = fakeId(3, 1);
const CARD_A2 = fakeId(3, 2);
const CARD_B1 = fakeId(3, 3);
const [T1, T2, T3] = [1, 2, 3].map((n) => fakeId(4, n)) as [string, string, string];
const TB1 = fakeId(4, 10);

const row = (id: string, userId: string, accountId: string, cardId: string, at: string): SeedRow => ({
  id,
  userId,
  accountId,
  cardId,
  amount: '125.50',
  type: 'PURCHASE',
  status: 'POSTED',
  at,
  postedAt: at,
});

const ROWS = [
  row(T1, A, A1, CARD_A1, '2026-09-03T10:00:00Z'),
  row(T2, A, A1, CARD_A1, '2026-09-02T10:00:00Z'),
  row(T3, A, A2, CARD_A2, '2026-09-01T10:00:00Z'),
  row(TB1, B, B1, CARD_B1, '2026-09-03T10:00:00Z'),
];

const mustNotBeCalled: Upstream = () => {
  throw new Error('the raw lookup must make no outbound s2s calls');
};

const PRINCIPALS = {
  'hdr.token-svc.signature': serviceToken(['transactions/read']),
  'hdr.token-svc-other-scopes.signature': serviceToken(['users/read', 'disputes/read']),
  'hdr.token-a.signature': userToken(A),
};

type LookupBody = { readonly items: ReadonlyArray<Record<string, unknown>> };

let db: TestDb;
let open: Harness | undefined;

beforeAll(async () => {
  db = await startTestDb();
  await seed(db.migrator, ROWS);
});

afterEach(async () => {
  await open?.servers.close();
  open = undefined;
});

afterAll(async () => {
  await db?.stop();
});

const lookup = async (query: string, token = 'hdr.token-svc.signature') => {
  open = buildHarness(db.app, PRINCIPALS, { users: mustNotBeCalled, disputes: mustNotBeCalled });
  const res = await open.servers.service.inject({
    method: 'GET',
    url: `/transactions?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json<LookupBody>(), calls: open.calls };
};

const ids = (body: LookupBody) => body.items.map((i) => i.transactionId);

describe('GET :8081/transactions (service)', () => {
  it.each([
    ['only the user’s rows among the ids', `userId=${A}&transactionIds=${T1},${T3},${TB1}`, [T1, T3]],
    ['accountId filter', `userId=${A}&transactionIds=${T1},${T2},${T3}&accountId=${A1}`, [T1, T2]],
    ['cardId filter', `userId=${A}&transactionIds=${T1},${T2},${T3}&cardId=${CARD_A2}`, [T3]],
    ['another user’s account → empty', `userId=${A}&transactionIds=${T1},${TB1}&accountId=${B1}`, []],
    ['unknown ids simply absent', `userId=${B}&transactionIds=${T1},${fakeId(9, 9)}`, []],
  ])('returns %s, raw, with no outbound s2s calls', async (_name, query, expected) => {
    const { status, body, calls } = await lookup(query);
    expect(status).toBe(200);
    expect(ids(body)).toEqual(expected);
    expect(calls.every((c) => c.url.origin === AUTH_URL || c.url.href === TOKEN_URL)).toBe(true);
  });

  it('returns raw rows (no dispute fields) that satisfy the generated response contract', async () => {
    const { body } = await lookup(`userId=${A}&transactionIds=${T1}`);
    expectContract(zLookupTransactionsResponse, body);
    expect(body.items).toEqual([
      {
        transactionId: T1,
        accountId: A1,
        cardId: CARD_A1,
        amount: '125.50',
        currency: 'ZAR',
        merchantName: 'Fake Merchant',
        mcc: '5411',
        type: 'PURCHASE',
        status: 'POSTED',
        transactionAt: '2026-09-03T10:00:00.000000Z',
        postedAt: '2026-09-03T10:00:00.000000Z',
      },
    ]);
  });

  it.each([
    ['more than 100 ids', `userId=${A}&transactionIds=${Array.from({ length: 101 }, (_, i) => fakeId(8, i)).join(',')}`],
    ['missing userId', `transactionIds=${T1}`],
    ['missing transactionIds', `userId=${A}`],
    ['bad uuid in ids', `userId=${A}&transactionIds=${T1},nope`],
    ['bad accountId', `userId=${A}&transactionIds=${T1}&accountId=nope`],
  ])('400 on %s', async (_name, query) => {
    expect((await lookup(query)).status).toBe(400);
  });

  it('rejects a user token on the service port with 403', async () => {
    expect((await lookup(`userId=${A}&transactionIds=${T1}`, 'hdr.token-a.signature')).status).toBe(403);
  });

  it('rejects a service token lacking transactions/read (other scopes present) with 403', async () => {
    expect((await lookup(`userId=${A}&transactionIds=${T1}`, 'hdr.token-svc-other-scopes.signature')).status).toBe(403);
  });
});
