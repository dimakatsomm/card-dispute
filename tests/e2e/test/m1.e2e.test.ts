import { beforeAll, describe, expect, it } from 'vitest';
import { call, listTransactions, serviceToken, URLS, userToken, type Json, type Reply, type Txn } from '../src/stack.ts';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 120;
const LIVE_TYPES = ['PURCHASE', 'ATM_WITHDRAWAL', 'FEE'];

const hooksEnabled = (await fetch(`${URLS.issuer}/test/tokens?variant=expired&user=A`)).status === 200;

let tokenA: string;
let tokenB: string;
let me: Json;
let expiredCardId: string;
let liveCard: Json;
let liveAccountId: string;

const disputeUrl = (transactionId: string): string => `${URLS.disputes}/dispute/${transactionId}`;
const get = (url: string, token: string): Promise<Reply> => call('GET', url, { token });
const problemCode = (reply: Reply): unknown => reply.body['code'];

beforeAll(async () => {
  [tokenA, tokenB] = await Promise.all([userToken('A'), userToken('B')]);
  me = (await get(`${URLS.users}/me`, tokenA)).body;
  const cards: Json[] = me['accounts'].flatMap((account: Json) => account['cards']);
  expiredCardId = cards.find((card) => card['expired'] === true)?.['cardId'];
  liveCard = cards.find((card) => card['expired'] === false && card['status'] === 'ACTIVE') ?? {};
  liveAccountId = liveCard['accountId'];
});

describe('M1 outcome 1: the local stack is up and a mock-issuer token works', () => {
  it('users, transactions, disputes, the frontend and the issuer all answer', async () => {
    const health = await Promise.all([
      call('GET', `${URLS.users}/health`),
      call('GET', `${URLS.transactions}/health`),
      call('GET', `${URLS.disputes}/health`),
      call('GET', `${URLS.issuer}/health`),
      call('GET', `${URLS.frontend}/`),
    ]);
    expect(health.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it('the frontend proxy forwards /api to the services with the same token', async () => {
    const reply = await get(`${URLS.frontend}/api/me`, tokenA);
    expect(reply.status).toBe(200);
    expect(reply.body['userId']).toBe(me['userId']);
  });
});

describe('M1 outcome 2: customer A sees accounts with masked cards on GET /me', () => {
  it('returns accounts and cards with last4 only and no PAN, CVV or token', () => {
    expect(me['accounts'].length).toBeGreaterThan(0);
    const cards: Json[] = me['accounts'].flatMap((account: Json) => account['cards']);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card['last4']).toMatch(/^\d{4}$/);
      expect(card).not.toHaveProperty('token');
      expect(card).not.toHaveProperty('cvv');
      expect(JSON.stringify(card)).not.toMatch(/\d{12,}/);
    }
    for (const account of me['accounts']) expect(account['accountNumberMasked']).toMatch(/^\*+\d{4}$/);
  });

  it('includes an expired card and a live card for the later outcomes', () => {
    expect(expiredCardId).toBeTypeOf('string');
    expect(liveCard['cardId']).toBeTypeOf('string');
  });
});

describe('M1 outcome 3: GET /transactions filtered by card carries a disputable flag on every row', () => {
  it('filters by card and puts a disputable flag on every row', async () => {
    const items = await listTransactions(tokenA, { cardId: liveCard['cardId'] });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.cardId).toBe(liveCard['cardId']);
      expect(item.disputable.allowed).toBeTypeOf('boolean');
      if (!item.disputable.allowed) expect(item.disputable.reason).toBeTypeOf('string');
    }
  });

  it('gives a reason for expired-card, non-posted, out-of-window and already-disputed rows', async () => {
    const all = await listTransactions(tokenA);
    const now = Date.now();
    const onLiveCard = (item: Txn): boolean => item.cardId !== expiredCardId && item.dispute === null;
    const age = (item: Txn): number => (now - Date.parse(item.postedAt ?? '')) / DAY_MS;

    const expired = all.filter((item) => item.cardId === expiredCardId && item.dispute === null);
    const notPosted = all.filter((item) => onLiveCard(item) && item.status !== 'POSTED' && LIVE_TYPES.includes(item.type));
    const outside = all.filter(
      (item) => onLiveCard(item) && item.status === 'POSTED' && LIVE_TYPES.includes(item.type) && age(item) > WINDOW_DAYS + 2,
    );
    const disputed = all.filter((item) => item.dispute !== null);

    for (const [name, rows, reason] of [
      ['expired card', expired, 'CARD_EXPIRED'],
      ['non-posted', notPosted, 'TXN_NOT_POSTED'],
      ['out-of-window', outside, 'OUTSIDE_WINDOW'],
      ['already disputed', disputed, 'ALREADY_DISPUTED'],
    ] as const) {
      expect(rows.length, `seed has a ${name} row`).toBeGreaterThan(0);
      for (const row of rows) expect(row.disputable, `${name} ${row.transactionId}`).toEqual({ allowed: false, reason });
    }
  });
});

describe('M1 UI flow: dispute lifecycle on a fresh disputable row', () => {
  let cardTxns: readonly Txn[];
  let target: Txn;
  let etag: string;
  let disputeId: string;
  const description = `e2e dispute ${new Date().toISOString()}`;

  it('/me, then account, then card narrows /transactions each step', async () => {
    const account = me['accounts'].find((candidate: Json) => candidate['accountId'] === liveAccountId);
    const byAccount = await listTransactions(tokenA, { accountId: account['accountId'] });
    expect(byAccount.length).toBeGreaterThan(0);
    expect(byAccount.every((item) => item.accountId === account['accountId'])).toBe(true);

    const card = account['cards'].find((candidate: Json) => candidate['expired'] === false);
    cardTxns = await listTransactions(tokenA, { cardId: card['cardId'] });
    expect(cardTxns.length).toBeGreaterThan(0);
    expect(cardTxns.every((item) => item.cardId === card['cardId'])).toBe(true);
    expect(byAccount.length).toBeGreaterThanOrEqual(cardTxns.length);
  });

  it('raises a dispute on a fresh disputable row (POST 201, SUBMITTED)', async () => {
    const candidate = cardTxns.find((item) => item.disputable.allowed);
    if (candidate === undefined) throw new Error('no disputable transaction left for user A on the live card; reseed');
    target = candidate;

    const reply = await call('POST', disputeUrl(target.transactionId), {
      token: tokenA,
      body: { reasonCode: 'NOT_RECEIVED', description },
    });
    expect(reply.status).toBe(201);
    expect(reply.body['status']).toBe('SUBMITTED');
    expect(reply.body['transactionId']).toBe(target.transactionId);
    expect(reply.body['version']).toBe(1);
    etag = reply.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    disputeId = reply.body['disputeId'];
  });

  it('the row now shows the dispute and allowed:false ALREADY_DISPUTED', async () => {
    const [row] = await listTransactions(tokenA, { transactionId: target.transactionId });
    expect(row?.dispute).toEqual({ disputeId, status: 'SUBMITTED' });
    expect(row?.disputable).toEqual({ allowed: false, reason: 'ALREADY_DISPUTED' });
  });

  it('GET /disputes lists it, also through the account and card filters', async () => {
    const ids = async (query: string): Promise<string[]> => {
      const reply = await get(`${URLS.disputes}/disputes?${query}`, tokenA);
      expect(reply.status).toBe(200);
      return reply.body['items'].map((item: Json) => item['disputeId']);
    };
    expect(await ids('limit=100')).toContain(disputeId);
    expect(await ids(`cardId=${target.cardId}&limit=100`)).toContain(disputeId);
    expect(await ids(`accountId=${target.accountId}&limit=100`)).toContain(disputeId);
  });

  it('GET /dispute/{transactionId} shows a timeline starting with SUBMITTED by the customer', async () => {
    const reply = await get(disputeUrl(target.transactionId), tokenA);
    expect(reply.status).toBe(200);
    expect(reply.body['disputeId']).toBe(disputeId);
    expect(reply.body['timeline'][0]).toMatchObject({ type: 'SUBMITTED', by: 'CUSTOMER' });
  });

  it('edits the dispute (PUT EDIT with If-Match) and the timeline records it', async () => {
    const edited = `${description} (edited)`;
    const reply = await call('PUT', disputeUrl(target.transactionId), {
      token: tokenA,
      headers: { 'if-match': etag },
      body: { action: 'EDIT', description: edited },
    });
    expect(reply.status).toBe(200);
    expect(reply.body['description']).toBe(edited);
    expect(reply.body['version']).toBe(2);
    etag = reply.headers.get('etag') ?? '';

    const detail = await get(disputeUrl(target.transactionId), tokenA);
    expect(detail.body['timeline'].map((event: Json) => event['type'])).toEqual(['SUBMITTED', 'EDITED']);
  });

  it('withdraws the dispute (PUT WITHDRAW) and the timeline ends in WITHDRAWN', async () => {
    const reply = await call('PUT', disputeUrl(target.transactionId), {
      token: tokenA,
      headers: { 'if-match': etag },
      body: { action: 'WITHDRAW' },
    });
    expect(reply.status).toBe(200);
    expect(reply.body['status']).toBe('WITHDRAWN');

    const detail = await get(disputeUrl(target.transactionId), tokenA);
    expect(detail.body['timeline'].at(-1)).toMatchObject({ type: 'WITHDRAWN', by: 'CUSTOMER' });
  });

  it('a withdrawn transaction cannot be disputed again (409 ALREADY_DISPUTED)', async () => {
    const reply = await call('POST', disputeUrl(target.transactionId), {
      token: tokenA,
      body: { reasonCode: 'FRAUD', description: 'second attempt after withdrawal' },
    });
    expect(reply.status).toBe(409);
    expect(problemCode(reply)).toBe('ALREADY_DISPUTED');

    const [row] = await listTransactions(tokenA, { transactionId: target.transactionId });
    expect(row?.disputable).toEqual({ allowed: false, reason: 'ALREADY_DISPUTED' });
    expect(row?.dispute?.status).toBe('WITHDRAWN');
  });

  it('an expired-card row shows CARD_EXPIRED and POST is rejected with 422 CARD_EXPIRED', async () => {
    const rows = await listTransactions(tokenA, { cardId: expiredCardId });
    const row = rows.find((item) => item.status === 'POSTED' && item.dispute === null);
    if (row === undefined) throw new Error('seed has no undisputed POSTED row on the expired card');
    expect(row.disputable).toEqual({ allowed: false, reason: 'CARD_EXPIRED' });

    const reply = await call('POST', disputeUrl(row.transactionId), {
      token: tokenA,
      body: { reasonCode: 'FRAUD', description: 'dispute on an expired card' },
    });
    expect(reply.status).toBe(422);
    expect(problemCode(reply)).toBe('CARD_EXPIRED');
    expect((await get(disputeUrl(row.transactionId), tokenA)).status).toBe(404);
  });
});

describe("M1 outcome: customer B cannot reach customer A's data", () => {
  it("B gets 404 for A's dispute on GET, PUT and POST, and A's data is absent from B's lists", async () => {
    const disputed = (await listTransactions(tokenA)).find((item) => item.dispute !== null);
    if (disputed === undefined) throw new Error('user A has no disputed transaction');
    const url = disputeUrl(disputed.transactionId);

    expect((await get(url, tokenB)).status).toBe(404);
    const put = await call('PUT', url, { token: tokenB, headers: { 'if-match': '"1"' }, body: { action: 'WITHDRAW' } });
    expect(put.status).toBe(404);
    const post = await call('POST', url, { token: tokenB, body: { reasonCode: 'FRAUD', description: 'not my transaction' } });
    expect(post.status).toBe(404);

    expect(await listTransactions(tokenB, { transactionId: disputed.transactionId })).toEqual([]);
    const bList = await get(`${URLS.disputes}/disputes?limit=100`, tokenB);
    expect(bList.body['items'].map((item: Json) => item['transactionId'])).not.toContain(disputed.transactionId);
    const bMe = await get(`${URLS.users}/me`, tokenB);
    expect(JSON.stringify(bMe.body)).not.toContain(me['userId']);
  });

  it("B filtering transactions by A's account or card gets an empty page", async () => {
    expect(await listTransactions(tokenB, { accountId: liveAccountId })).toEqual([]);
    expect(await listTransactions(tokenB, { cardId: expiredCardId })).toEqual([]);
  });
});

describe('M1 outcome: token and principal rules on the public ports', () => {
  it('no token gets 401', async () => {
    expect((await call('GET', `${URLS.users}/me`)).status).toBe(401);
  });

  it('a JWT with a forged signature gets 401', async () => {
    const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const forged = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub: 'x', iss: URLS.issuer, exp: 9_999_999_999 })}.AAAA`;
    expect((await get(`${URLS.users}/me`, forged)).status).toBe(401);
  });

  it('a bearer value that is not a JWT at all gets 401, not 503', async () => {
    expect((await get(`${URLS.users}/me`, 'not-a-jwt')).status).toBe(401);
  });

  it.skipIf(!hooksEnabled)('an expired token gets 401 (needs MOCK_ISSUER_TEST_HOOKS)', async () => {
    const res = await fetch(`${URLS.issuer}/test/tokens?variant=expired&user=A`);
    const { access_token: token } = (await res.json()) as { access_token: string };
    expect((await get(`${URLS.users}/me`, token)).status).toBe(401);
  });

  it('a service token on a public customer route gets 403', async () => {
    const token = await serviceToken();
    expect((await get(`${URLS.users}/me`, token)).status).toBe(403);
  });

  it('service-only GET /cards does not exist on the public port (404 for user and service tokens)', async () => {
    const service = await serviceToken();
    const withUser = await get(`${URLS.users}/cards?userId=${me['userId']}`, tokenA);
    const withService = await get(`${URLS.users}/cards?userId=${me['userId']}`, service);
    expect([withUser.status, withService.status]).toEqual([404, 404]);
  });
});
