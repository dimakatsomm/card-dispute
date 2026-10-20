import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DISPUTES_URL,
  TOKEN_URL,
  USERS_URL,
  buildHarness,
  fakeId,
  hang,
  json,
  outboundTo,
  seed,
  serviceToken,
  startTestDb,
  userToken,
  type Harness,
  type SeedRow,
  type TestDb,
  type Upstream,
} from '../helpers.ts';

const DAY = 86_400_000;
const A = fakeId(1, 1);
const B = fakeId(1, 2);
const C = fakeId(1, 3);
const A1 = fakeId(2, 1);
const A2 = fakeId(2, 2);
const B1 = fakeId(2, 3);
const C1 = fakeId(2, 4);
const CARD_A1 = fakeId(3, 1);
const CARD_A2_EXPIRED = fakeId(3, 2);
const CARD_B1 = fakeId(3, 3);
const CARD_C1 = fakeId(3, 4);
const [T1, T2, T3, T4, T5] = [1, 2, 3, 4, 5].map((n) => fakeId(4, n)) as [string, string, string, string, string];
const TB1 = fakeId(4, 10);
const DISPUTE_T5 = fakeId(6, 1);

// Recent enough that the 120-day window (judged against the DB clock) never interferes.
const base = Math.floor((Date.now() - DAY) / 1000) * 1000;
const daysAgo = (n: number): string => new Date(base - n * DAY).toISOString();

const row = (r: Partial<SeedRow> & Pick<SeedRow, 'id' | 'at'>): SeedRow => ({
  userId: A,
  accountId: A1,
  cardId: CARD_A1,
  amount: '10.00',
  type: 'PURCHASE',
  status: 'POSTED',
  postedAt: r.at,
  ...r,
});

const ROWS_A: ReadonlyArray<SeedRow> = [
  row({ id: T1, amount: '125.50', at: daysAgo(1) }),
  row({ id: T2, amount: '40.00', type: 'REFUND', at: daysAgo(2) }),
  row({ id: T3, accountId: A2, cardId: CARD_A2_EXPIRED, amount: '300.00', status: 'PENDING', at: daysAgo(3), postedAt: null }),
  row({ id: T4, accountId: A2, cardId: CARD_A2_EXPIRED, amount: '1000.00', type: 'ATM_WITHDRAWAL', at: daysAgo(4) }),
  row({ id: T5, amount: '99.99', at: daysAgo(5) }),
];
const ROW_B = row({ id: TB1, userId: B, accountId: B1, cardId: CARD_B1, at: daysAgo(1) });

// Ties on transactionAt (incl. a 1 µs difference a JS Date cannot represent) for the paging walk.
const TIE_AT = '2026-06-01T10:00:00.000000Z';
const ROWS_C: ReadonlyArray<SeedRow> = [
  ...[1, 2, 3].map((n) => row({ id: fakeId(5, n), userId: C, accountId: C1, cardId: CARD_C1, at: TIE_AT })),
  row({ id: fakeId(5, 4), userId: C, accountId: C1, cardId: CARD_C1, at: '2026-06-01T10:00:00.000001Z' }),
  row({ id: fakeId(5, 5), userId: C, accountId: C1, cardId: CARD_C1, at: '2026-06-01T10:00:00.000002Z' }),
  ...[6, 7].map((n) => row({ id: fakeId(5, n), userId: C, accountId: C1, cardId: CARD_C1, at: '2026-05-01T08:00:00Z' })),
  row({ id: fakeId(5, 8), userId: C, accountId: C1, cardId: CARD_C1, at: '2026-04-01T08:00:00Z' }),
];

const card = (cardId: string, userId: string, accountId: string, expiryYear: number) => ({
  cardId,
  accountId,
  userId,
  brand: 'VISA',
  cardType: 'DEBIT',
  last4: '4821',
  expiryMonth: 12,
  expiryYear,
  expired: expiryYear < 2026,
  status: 'ACTIVE',
});

const CARDS: Readonly<Record<string, ReadonlyArray<unknown>>> = {
  [A]: [card(CARD_A1, A, A1, 2099), card(CARD_A2_EXPIRED, A, A2, 2020)],
  [B]: [card(CARD_B1, B, B1, 2099)],
  [C]: [card(CARD_C1, C, C1, 2099)],
};

const usersOk: Upstream = (call) => json(200, { cards: CARDS[call.url.searchParams.get('userId') ?? ''] ?? [] });

const disputesOk: Upstream = (call) => {
  const ids = (call.url.searchParams.get('transactionIds') ?? '').split(',');
  return json(200, {
    items: ids.includes(T5) ? [{ transactionId: T5, disputeId: DISPUTE_T5, status: 'WITHDRAWN' }] : [],
  });
};

const PRINCIPALS = {
  'hdr.token-a.signature': userToken(A),
  'hdr.token-b.signature': userToken(B),
  'hdr.token-c.signature': userToken(C),
  'hdr.token-svc.signature': serviceToken(['transactions/read']),
};

type Item = {
  readonly transactionId: string;
  readonly amount: unknown;
  readonly dispute: unknown;
  readonly disputable: unknown;
};
type ListBody = { readonly items: ReadonlyArray<Item>; readonly nextCursor: string | null };

let db: TestDb;
let open: Harness | undefined;

beforeAll(async () => {
  db = await startTestDb();
  await seed(db.migrator, [...ROWS_A, ROW_B, ...ROWS_C]);
});

afterEach(async () => {
  await open?.servers.close();
  open = undefined;
});

afterAll(async () => {
  await db?.stop();
});

const harness = (users: Upstream = usersOk, disputes: Upstream = disputesOk): Harness => {
  open = buildHarness(db.app, PRINCIPALS, { users, disputes });
  return open;
};

const list = async (h: Harness, token: string, query = '') => {
  const res = await h.servers.public.inject({
    method: 'GET',
    url: `/transactions${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json<ListBody>() };
};

const idsOf = (body: ListBody): ReadonlyArray<string> => body.items.map((i) => i.transactionId);

describe('GET /transactions (public)', () => {
  it('scopes every query to the caller: user B with A’s accountId, cardId or transactionId gets empty items', async () => {
    const h = harness();
    for (const query of [`?accountId=${A1}`, `?cardId=${CARD_A1}`, `?transactionId=${T1}`]) {
      expect(await list(h, 'hdr.token-b.signature', query)).toEqual({ status: 200, body: { items: [], nextCursor: null } });
    }
    expect(idsOf((await list(h, 'hdr.token-b.signature')).body)).toEqual([TB1]);
  });

  it('ignores a client-supplied userId: identity comes only from the token', async () => {
    const h = harness();
    expect(idsOf((await list(h, 'hdr.token-b.signature', `?userId=${A}`)).body)).toEqual([TB1]);
    expect(await list(h, 'hdr.token-b.signature', `?userId=${A}&cardId=${CARD_A1}`)).toEqual({
      status: 200,
      body: { items: [], nextCursor: null },
    });
  });

  it.each([
    ['no filter = all the caller’s accounts', '', [T1, T2, T3, T4, T5]],
    ['accountId', `?accountId=${A1}`, [T1, T2, T5]],
    ['cardId', `?cardId=${CARD_A2_EXPIRED}`, [T3, T4]],
    ['transactionId', `?transactionId=${T2}`, [T2]],
    ['from inclusive, to exclusive', `?from=${daysAgo(3)}&to=${daysAgo(1)}`, [T2, T3]],
    ['single status', '?status=PENDING', [T3]],
    ['repeated status', '?status=PENDING&status=POSTED', [T1, T2, T3, T4, T5]],
    ['minAmount', '?minAmount=100.00', [T1, T3, T4]],
    ['maxAmount', '?maxAmount=99.99', [T2, T5]],
    ['minAmount = maxAmount bounds', '?minAmount=99.99&maxAmount=125.50', [T1, T5]],
    ['combined', `?accountId=${A1}&status=POSTED&minAmount=50.00`, [T1, T5]],
  ])('filter: %s', async (_name, query, expected) => {
    const { status, body } = await list(harness(), 'hdr.token-a.signature', query);
    expect(status).toBe(200);
    expect(idsOf(body)).toEqual(expected);
  });

  it.each([
    ['from > to', `?from=${daysAgo(1)}&to=${daysAgo(3)}`],
    ['from = to', `?from=${daysAgo(1)}&to=${daysAgo(1)}`],
    ['minAmount > maxAmount', '?minAmount=100.00&maxAmount=99.99'],
    ['bad accountId uuid', '?accountId=not-a-uuid'],
    ['bad cardId uuid', '?cardId=1234'],
    ['bad transactionId uuid', `?transactionId=${T1}x`],
    ['limit > 100', '?limit=101'],
    ['limit 0', '?limit=0'],
    ['unknown status', '?status=SETTLED'],
    ['money without 2 places', '?minAmount=1.5'],
    ['non-timestamp from', '?from=yesterday'],
    ['year 0000 from, which Postgres cannot store', '?from=0000-01-01T00:00:00Z'],
    ['year 0000 to', '?to=0000-01-01T00:00:00Z'],
    ['offset beyond what Postgres accepts', `?from=${encodeURIComponent('2026-01-01T00:00:00+23:00')}`],
  ])('400 on %s', async (_name, query) => {
    const res = await harness().servers.public.inject({
      method: 'GET',
      url: `/transactions${query}`,
      headers: { authorization: 'Bearer hdr.token-a.signature' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  const forge = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['not base64 JSON', 'bm90LWEtY3Vyc29y'],
    ['year 0000', forge(['0000-01-01T00:00:00.000000Z', T1])],
    ['impossible date Date.parse rolls over', forge(['2026-02-30T00:00:00.000000Z', T1])],
    ['hour 24', forge(['2026-01-01T24:00:00.000000Z', T1])],
  ])('400 INVALID_CURSOR on a forged cursor: %s', async (_name, cursor) => {
    const res = await harness().servers.public.inject({
      method: 'GET',
      url: `/transactions?cursor=${cursor}`,
      headers: { authorization: 'Bearer hdr.token-a.signature' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it.each([1, 2, 3])(
    'walking all pages (limit %i) returns every row exactly once in order, with ties on transactionAt',
    async (limit) => {
      const h = harness();
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = `?limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const { status, body } = await list(h, 'hdr.token-c.signature', query);
        expect(status).toBe(200);
        expect(body.items.length).toBeLessThanOrEqual(limit);
        seen.push(...idsOf(body));
        cursor = body.nextCursor;
      } while (cursor !== null);

      const expected = await db.app.query<{ transaction_id: string }>(
        `select transaction_id from transaction where user_id = $1 order by transaction_at desc, transaction_id desc`,
        [C],
      );
      expect(seen).toEqual(expected.rows.map((r) => r.transaction_id));
      expect(new Set(seen).size).toBe(ROWS_C.length);
    },
  );

  it('computes dispute + disputable per row with evaluateTransactionEligibility, one disputes batch per page', async () => {
    const h = harness();
    const { status, body } = await list(h, 'hdr.token-a.signature');
    expect(status).toBe(200);
    const byId = new Map(body.items.map((i) => [i.transactionId, i]));
    expect(byId.get(T1)).toMatchObject({ dispute: null, disputable: { allowed: true } });
    expect(byId.get(T5)).toMatchObject({
      dispute: { disputeId: DISPUTE_T5, status: 'WITHDRAWN' },
      disputable: { allowed: false, reason: 'ALREADY_DISPUTED' },
    });
    expect(byId.get(T4)).toMatchObject({ dispute: null, disputable: { allowed: false, reason: 'CARD_EXPIRED' } });
    expect(byId.get(T2)).toMatchObject({ disputable: { allowed: false, reason: 'TXN_TYPE_NOT_DISPUTABLE' } });

    const disputeCalls = outboundTo(h.calls, DISPUTES_URL);
    expect(disputeCalls).toHaveLength(1);
    expect(disputeCalls[0]?.url.pathname).toBe('/disputes');
    expect(disputeCalls[0]?.url.searchParams.get('userId')).toBe(A);
    expect(disputeCalls[0]?.url.searchParams.get('transactionIds')?.split(',')).toEqual([T1, T2, T3, T4, T5]);
    expect(disputeCalls[0]?.headers.authorization).toBe('Bearer svc-transactions-token');
  });

  it('recovers from a stale service token: a callee 401 refetches the token and retries once', async () => {
    let seen = 0;
    const h = harness(usersOk, (call, signal) => (++seen === 1 ? json(401, {}) : disputesOk(call, signal)));
    const { status, body } = await list(h, 'hdr.token-a.signature');
    expect(status).toBe(200);
    expect(body.items.find((i) => i.transactionId === T5)).toMatchObject({ dispute: { disputeId: DISPUTE_T5 } });
    expect(outboundTo(h.calls, DISPUTES_URL)).toHaveLength(2);
    expect(h.calls.filter((c) => c.url.href === TOKEN_URL)).toHaveLength(2);
  });

  it('recovers when auth rejects the cached service token on validate (401 then 200)', async () => {
    let seen = 0;
    open = buildHarness(db.app, PRINCIPALS, {
      users: usersOk,
      disputes: disputesOk,
      auth: () => (++seen === 1 ? json(401, {}) : undefined),
    });
    const { status } = await list(open, 'hdr.token-a.signature');
    expect(status).toBe(200);
    expect(open.calls.filter((c) => c.url.href === TOKEN_URL)).toHaveLength(2);
  });

  it('the deadline aborts the hung callee fetch and no second attempt starts', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const h = harness(usersOk, (call, signal) => {
      signals.push(signal);
      return hang(call, signal);
    });
    const { status } = await list(h, 'hdr.token-a.signature');
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('caches users GET /cards for 60 s per user', async () => {
    const h = harness();
    await list(h, 'hdr.token-a.signature');
    await list(h, 'hdr.token-a.signature', `?accountId=${A1}`);
    expect(outboundTo(h.calls, USERS_URL)).toHaveLength(1);
    await list(h, 'hdr.token-b.signature');
    expect(outboundTo(h.calls, USERS_URL)).toHaveLength(2);

    h.clock.now += 60_001;
    await list(h, 'hdr.token-a.signature');
    const usersCalls = outboundTo(h.calls, USERS_URL);
    expect(usersCalls).toHaveLength(3);
    expect(usersCalls.map((c) => c.url.searchParams.get('userId'))).toEqual([A, B, A]);
  });

  it.each<[string, Upstream, Upstream]>([
    ['users 503', () => json(503, {}), disputesOk],
    ['disputes 503', usersOk, () => json(503, {})],
    ['users unreachable', () => Promise.reject(new TypeError('fetch failed')), disputesOk],
    ['users malformed body', () => json(200, { cards: 'nope' }), disputesOk],
    ['users silent > 2 s', hang, disputesOk],
    ['disputes silent > 2 s', usersOk, hang],
  ])('%s → 200, every row dispute null + disputable UNAVAILABLE', async (_name, users, disputes) => {
    const started = performance.now();
    const { status, body } = await list(harness(users, disputes), 'hdr.token-a.signature');
    expect(performance.now() - started).toBeLessThan(3000);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(ROWS_A.length);
    for (const item of body.items) {
      expect(item).toMatchObject({ dispute: null, disputable: { allowed: false, reason: 'UNAVAILABLE' } });
    }
  });

  it('serialises amounts as decimal strings', async () => {
    const { body } = await list(harness(), 'hdr.token-a.signature');
    expect(body.items.map((i) => i.amount)).toEqual(['125.50', '40.00', '300.00', '1000.00', '99.99']);
  });

  it('rejects a service token on the public port with 403', async () => {
    const res = await harness().servers.public.inject({
      method: 'GET',
      url: '/transactions',
      headers: { authorization: 'Bearer hdr.token-svc.signature' },
    });
    expect(res.statusCode).toBe(403);
  });
});
