import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import { createFakeUpstreams, hang, json, URLS, type FakeUpstreams } from './helpers/fakes.ts';
import { seedDispute, seedHistory } from './helpers/seed.ts';
import { startTestService, type TestService } from './helpers/service.ts';

// Reads never sign uploads, so S3 is never contacted.
const UNUSED_S3 = 'http://127.0.0.1:1';

type Status = 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'WITHDRAWN';
type User = { readonly token: string; readonly userId: string };
type Summary = { readonly disputeId: string; readonly transactionId: string } & Record<string, unknown>;
type Page = { readonly items: ReadonlyArray<Summary>; readonly nextCursor: string | null };

let db: TestDb;
let upstreams: FakeUpstreams;
let svc: TestService;

const list = (service: TestService, user: User, query = '') =>
  service.servers.public.inject({
    method: 'GET',
    url: `/disputes${query}`,
    headers: { authorization: `Bearer ${user.token}` },
  });

const transactionCalls = () =>
  upstreams.calls.filter((c) => c.url.origin === URLS.transactions && c.url.pathname === '/transactions');

const seed = async (
  user: User,
  options: {
    readonly status?: Status;
    readonly updatedAt?: string;
    readonly accountId?: string;
    readonly cardId?: string;
  } = {},
) => {
  const txn = upstreams.addTransaction(user.userId, {
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(options.cardId === undefined ? {} : { cardId: options.cardId }),
  });
  const seeded = await seedDispute(db, {
    userId: user.userId,
    transactionId: txn.transactionId,
    status: options.status ?? 'SUBMITTED',
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
  });
  await seedHistory(db, seeded.rowId, {
    action: 'CREATE',
    fromStatus: null,
    toStatus: 'SUBMITTED',
    actorType: 'USER',
    actorId: user.userId,
    createdAt: '2026-10-01T08:00:00.000000Z',
  });
  return { txn, ...seeded };
};

const withService = async (
  fault: NonNullable<Parameters<typeof startTestService>[0]['fault']>,
  run: (service: TestService) => Promise<void>,
): Promise<void> => {
  const service = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: UNUSED_S3, fault });
  try {
    await run(service);
  } finally {
    await service.servers.close();
  }
};

const allPages = async (user: User, query: string): Promise<ReadonlyArray<string>> => {
  const collect = async (
    cursor: string | null,
    acc: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string>> => {
    const res = await list(svc, user, `${query}${cursor === null ? '' : `&cursor=${cursor}`}`);
    expect(res.statusCode).toBe(200);
    const page = res.json<Page>();
    const ids = [...acc, ...page.items.map((i) => i.disputeId)];
    return page.nextCursor === null ? ids : collect(page.nextCursor, ids);
  };
  return collect(null, []);
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

describe('GET /disputes', () => {
  it("lists only the caller's disputes, updatedAt desc, with lastEvent and transaction from one batch call", async () => {
    const me = upstreams.addUser();
    const other = upstreams.addUser();
    const older = await seed(me, { updatedAt: '2026-10-02T08:00:00.000000Z' });
    const newer = await seed(me, { status: 'UNDER_REVIEW', updatedAt: '2026-10-03T08:00:00.000000Z' });
    await seedHistory(db, newer.rowId, {
      action: 'REVIEW',
      fromStatus: 'SUBMITTED',
      toStatus: 'UNDER_REVIEW',
      actorType: 'AGENT',
      actorId: 'agent-sub-1',
      createdAt: '2026-10-03T08:00:00.000000Z',
    });
    await seed(other);
    const callsBefore = transactionCalls().length;

    const res = await list(svc, me);

    expect(res.statusCode).toBe(200);
    expect(transactionCalls().length - callsBefore).toBe(1);
    expect(res.json()).toEqual({
      items: [
        {
          disputeId: newer.disputeId,
          transactionId: newer.txn.transactionId,
          status: 'UNDER_REVIEW',
          reasonCode: 'FRAUD',
          transaction: {
            accountId: newer.txn.accountId,
            cardId: newer.txn.cardId,
            amount: '125.50',
            currency: 'ZAR',
            merchantName: 'Corner Cafe',
            transactionAt: newer.txn.transactionAt,
            postedAt: newer.txn.postedAt,
          },
          lastEvent: { type: 'UNDER_REVIEW', at: '2026-10-03T08:00:00.000Z' },
          createdAt: '2026-10-01T08:00:00.000Z',
          updatedAt: '2026-10-03T08:00:00.000Z',
        },
        expect.objectContaining({
          disputeId: older.disputeId,
          lastEvent: { type: 'SUBMITTED', at: '2026-10-01T08:00:00.000Z' },
        }),
      ],
      nextCursor: null,
    });
  });

  it('filters by status (repeatable)', async () => {
    const me = upstreams.addUser();
    const submitted = await seed(me, { status: 'SUBMITTED' });
    const withdrawn = await seed(me, { status: 'WITHDRAWN' });
    await seed(me, { status: 'UNDER_REVIEW' });

    const one = await list(svc, me, '?status=WITHDRAWN');
    expect(one.json<Page>().items.map((i) => i.disputeId)).toEqual([withdrawn.disputeId]);
    const two = await list(svc, me, '?status=WITHDRAWN&status=SUBMITTED');
    expect(new Set(two.json<Page>().items.map((i) => i.disputeId))).toEqual(
      new Set([withdrawn.disputeId, submitted.disputeId]),
    );
  });

  it('resolves accountId / cardId through transactions in chunks of 100 (150 disputes), reusing those rows', async () => {
    const me = upstreams.addUser();
    const accountId = randomUUID();
    const cardId = randomUUID();
    const onCard = await Promise.all(Array.from({ length: 20 }, () => seed(me, { accountId, cardId })));
    const onAccount = await Promise.all(Array.from({ length: 30 }, () => seed(me, { accountId })));
    await Promise.all(Array.from({ length: 100 }, () => seed(me)));
    const callsBefore = transactionCalls().length;

    const byAccount = await list(svc, me, `?accountId=${accountId}&limit=100`);

    expect(byAccount.statusCode).toBe(200);
    const lookups = transactionCalls().slice(callsBefore);
    const chunkSizes = lookups.map((c) => c.url.searchParams.get('transactionIds')?.split(',').length ?? 0);
    expect(chunkSizes.sort((a, b) => a - b)).toEqual([50, 100]);
    expect(lookups.every((c) => c.url.searchParams.get('accountId') === accountId)).toBe(true);
    const items = byAccount.json<Page>().items;
    expect(new Set(items.map((i) => i.disputeId))).toEqual(
      new Set([...onCard, ...onAccount].map((d) => d.disputeId)),
    );
    expect(items.every((i) => (i.transaction as { accountId: string }).accountId === accountId)).toBe(true);

    const byCard = await list(svc, me, `?cardId=${cardId}&limit=100`);
    expect(new Set(byCard.json<Page>().items.map((i) => i.disputeId))).toEqual(
      new Set(onCard.map((d) => d.disputeId)),
    );
  });

  it("an accountId or cardId the caller doesn't own → empty list", async () => {
    const me = upstreams.addUser();
    const other = upstreams.addUser();
    await seed(me);
    const theirs = await seed(other);
    for (const query of [`?accountId=${theirs.txn.accountId}`, `?cardId=${theirs.txn.cardId}`]) {
      const res = await list(svc, me, query);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    }
  });

  it.each([
    { name: 'returns 5xx', fault: () => Promise.resolve(json(502, {})) },
    { name: 'hangs', fault: (url: URL, _body: string, init?: RequestInit) => hang(url, init) },
  ])(
    'transactions $name: account/card filter → 503, unfiltered → 200 with transaction: null, within 2 s',
    async ({ fault }) => {
      const me = upstreams.addUser();
      const mine = await seed(me);
      await withService(
        (url, body, init) => (url.origin === URLS.transactions ? fault(url, body, init) : undefined),
        async (service) => {
          const filteredAt = Date.now();
          const filtered = await list(service, me, `?accountId=${mine.txn.accountId}`);
          expect(filtered.statusCode).toBe(503);
          expect(filtered.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
          expect(Date.now() - filteredAt).toBeLessThan(3_000);

          const unfilteredAt = Date.now();
          const unfiltered = await list(service, me);
          expect(unfiltered.statusCode).toBe(200);
          expect(unfiltered.json<Page>().items).toEqual([
            expect.objectContaining({ disputeId: mine.disputeId, transaction: null }),
          ]);
          expect(Date.now() - unfilteredAt).toBeLessThan(3_000);
        },
      );
    },
  );

  it('cursor pages by updatedAt desc and stays stable across exact and sub-millisecond ties', async () => {
    const me = upstreams.addUser();
    const stamps = [
      '2026-10-05T10:00:00.123456Z',
      '2026-10-05T10:00:00.123456Z',
      '2026-10-05T10:00:00.123456Z',
      '2026-10-05T10:00:00.123457Z',
      '2026-10-05T10:00:00.123455Z',
      '2026-10-04T10:00:00.000000Z',
      '2026-10-04T10:00:00.000000Z',
    ];
    const seeded = await Promise.all(stamps.map((updatedAt) => seed(me, { updatedAt })));
    const expected = seeded
      .map((d, i) => ({ id: d.disputeId, at: stamps[i] ?? '' }))
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
      .map((d) => d.id);

    expect(await allPages(me, '?limit=2')).toEqual(expected);
  });

  it.each([
    { name: 'not base64 JSON', cursor: 'not-a-cursor' },
    { name: 'year 0000', cursor: ['0000-01-01T00:00:00.000000Z', randomUUID()] },
    { name: 'February 30', cursor: ['2026-02-30T00:00:00.000000Z', randomUUID()] },
    { name: 'a non-uuid id', cursor: ['2026-10-05T10:00:00.123456Z', "x' or 1=1"] },
  ])('a cursor with $name → 400 INVALID_CURSOR, not a Postgres 500', async ({ cursor }) => {
    const me = upstreams.addUser();
    await seed(me);
    const raw =
      typeof cursor === 'string' ? cursor : Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const res = await list(svc, me, `?cursor=${encodeURIComponent(raw)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
