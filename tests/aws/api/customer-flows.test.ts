import { beforeAll, describe, expect, it } from 'vitest';
import { tokenFor } from '../src/auth.ts';
import { api, claimDisputable, listTransactions, type Json, type Txn } from '../src/http.ts';
import { awaitDelivery, eventsSince } from '../src/ses.ts';

const SES_WAIT_MS = 4 * 60_000;

let tokenA: string;
let tokenB: string;
let me: Json;
let liveCard: Json;
let expiredCardId: string;

const disputePath = (transactionId: string): string => `/dispute/${transactionId}`;

beforeAll(async () => {
  [tokenA, tokenB] = await Promise.all([tokenFor('A'), tokenFor('B')]);
  me = (await api('GET', '/me', { token: tokenA })).body;
  const cards: Json[] = me['accounts'].flatMap((account: Json) => account['cards']);
  expiredCardId = cards.find((card) => card['expired'] === true)?.['cardId'];
  liveCard = cards.find((card) => card['expired'] === false && card['status'] === 'ACTIVE') ?? {};
});

describe('M1: accounts, masked cards and transactions', () => {
  it('GET /me returns accounts with last4-only cards and no PAN, CVV or token', () => {
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

  it('GET /transactions filters by account and by card and flags every row as disputable or not with a reason', async () => {
    const byCard = await listTransactions(tokenA, { cardId: liveCard['cardId'] });
    expect(byCard.length).toBeGreaterThan(0);
    for (const item of byCard) {
      expect(item.cardId).toBe(liveCard['cardId']);
      expect(item.disputable.allowed).toBeTypeOf('boolean');
      if (!item.disputable.allowed) expect(item.disputable.reason).toBeTypeOf('string');
    }
    const byAccount = await listTransactions(tokenA, { accountId: liveCard['accountId'] });
    expect(byAccount.every((item) => item.accountId === liveCard['accountId'])).toBe(true);
    expect(byAccount.length).toBeGreaterThanOrEqual(byCard.length);
  });

  it("customer B sees none of A's transactions through A's account or card filters", async () => {
    expect(
      (await listTransactions(tokenB, { accountId: liveCard['accountId'] })).length,
      'B rows via A account',
    ).toBe(0);
    expect((await listTransactions(tokenB, { cardId: liveCard['cardId'] })).length, 'B rows via A card').toBe(
      0,
    );
    const bMe = JSON.stringify((await api('GET', '/me', { token: tokenB })).body);
    expect(bMe.includes(me['userId']), 'B response leaks A userId').toBe(false);
  });

  it('a transaction on the expired card is flagged CARD_EXPIRED and POST is refused with 422 without creating a dispute', async () => {
    const row = (await listTransactions(tokenA, { cardId: expiredCardId })).find(
      (item) => item.status === 'POSTED' && item.dispute === null,
    );
    if (row === undefined) throw new Error('seed has no undisputed POSTED row on the expired card');
    expect(row.disputable).toEqual({ allowed: false, reason: 'CARD_EXPIRED' });
    const reply = await api('POST', disputePath(row.transactionId), {
      token: tokenA,
      body: { reasonCode: 'FRAUD', description: 'dispute on an expired card' },
    });
    expect(reply.status).toBe(422);
    expect(reply.body['code']).toBe('CARD_EXPIRED');
    expect((await api('GET', disputePath(row.transactionId), { token: tokenA })).status).toBe(404);
  });
});

describe('M1 + M2: dispute lifecycle, ownership and notification mail (consumes 1 transaction)', () => {
  const startedAt = Date.now() - 10_000;
  let target: Txn;
  let etag = '';
  let disputeId = '';
  let owner = '';

  it('raises a dispute on a dynamically chosen disputable row (201 SUBMITTED, version 1)', async () => {
    target = await claimDisputable(tokenA);
    const reply = await api('POST', disputePath(target.transactionId), {
      token: tokenA,
      body: { reasonCode: 'NOT_RECEIVED', description: `e2e-aws lifecycle ${new Date().toISOString()}` },
    });
    expect(reply.status).toBe(201);
    expect(reply.body['status']).toBe('SUBMITTED');
    expect(reply.body['transactionId']).toBe(target.transactionId);
    expect(reply.body['version']).toBe(1);
    etag = reply.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    disputeId = reply.body['disputeId'];
    owner = me['email'];
  });

  it('the row, the dispute list and the dispute detail agree, and the timeline starts with SUBMITTED by the customer', async () => {
    const [row] = await listTransactions(tokenA, { transactionId: target.transactionId });
    expect(row?.dispute).toEqual({ disputeId, status: 'SUBMITTED' });
    expect(row?.disputable).toEqual({ allowed: false, reason: 'ALREADY_DISPUTED' });
    const list = await api('GET', '/disputes?limit=100', { token: tokenA });
    expect(list.body['items'].map((item: Json) => item['disputeId'])).toContain(disputeId);
    const detail = await api('GET', disputePath(target.transactionId), { token: tokenA });
    expect(detail.body['timeline'][0]).toMatchObject({ type: 'SUBMITTED', by: 'CUSTOMER' });
  });

  it("customer B gets 404 for A's dispute on GET, PUT and POST and does not see it in B's own list", async () => {
    const url = disputePath(target.transactionId);
    expect((await api('GET', url, { token: tokenB })).status).toBe(404);
    expect(
      (await api('PUT', url, { token: tokenB, headers: { 'if-match': etag }, body: { action: 'WITHDRAW' } }))
        .status,
    ).toBe(404);
    expect(
      (
        await api('POST', url, {
          token: tokenB,
          body: { reasonCode: 'FRAUD', description: 'not my transaction' },
        })
      ).status,
    ).toBe(404);
    const list = await api('GET', '/disputes?limit=100', { token: tokenB });
    expect(list.body['items'].map((item: Json) => item['transactionId'])).not.toContain(target.transactionId);
  });

  it('a stale If-Match is refused with 412 and the edit with the current ETag succeeds as version 2', async () => {
    const stale = await api('PUT', disputePath(target.transactionId), {
      token: tokenA,
      headers: { 'if-match': '"99"' },
      body: { action: 'EDIT', description: 'e2e-aws stale edit attempt' },
    });
    expect(stale.status).toBe(412);
    const edited = await api('PUT', disputePath(target.transactionId), {
      token: tokenA,
      headers: { 'if-match': etag },
      body: { action: 'EDIT', description: `e2e-aws lifecycle edited ${new Date().toISOString()}` },
    });
    expect(edited.status).toBe(200);
    expect(edited.body['version']).toBe(2);
    etag = edited.headers.get('etag') ?? '';
  });

  it('withdraws the dispute (final), the timeline records the changes in order, and a second dispute is refused with 409', async () => {
    const withdrawn = await api('PUT', disputePath(target.transactionId), {
      token: tokenA,
      headers: { 'if-match': etag },
      body: { action: 'WITHDRAW' },
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body['status']).toBe('WITHDRAWN');

    const detail = await api('GET', disputePath(target.transactionId), { token: tokenA });
    expect(detail.body['timeline'].map((event: Json) => event['type'])).toEqual([
      'SUBMITTED',
      'EDITED',
      'WITHDRAWN',
    ]);

    const again = await api('POST', disputePath(target.transactionId), {
      token: tokenA,
      body: { reasonCode: 'FRAUD', description: 'second attempt after withdrawal' },
    });
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('ALREADY_DISPUTED');
  });

  // SES sandbox: only verified identities receive mail, and the seed gives users @example.com addresses.
  it(
    'SES reports a Delivery for every status change, to the dispute owner only',
    async (ctx) => {
      if (/@example\.(com|org|net)$/i.test(owner)) {
        ctx.skip(
          `user A's address (${owner.replace(/^[^@]*/, '***')}) cannot be a verified SES sandbox identity; set A's app_user email to the verified address to run this check`,
        );
      }
      await awaitDelivery('We have received your dispute', owner, startedAt, SES_WAIT_MS);
      await awaitDelivery('Your dispute has been updated', owner, startedAt, SES_WAIT_MS);
      await awaitDelivery('Your dispute has been withdrawn', owner, startedAt, SES_WAIT_MS);

      const window = eventsSince(startedAt);
      const failures = window
        .map((event) => event.type)
        .filter((type) => ['Bounce', 'Reject', 'Complaint'].includes(type));
      expect(failures, 'SES failure event types').toEqual([]);
      window.forEach((event, index) => {
        const ownerOnly = event.to.length === 1 && event.to[0] === owner;
        expect(ownerOnly, `${event.type} event #${index} not addressed to the owner only`).toBe(true);
      });
    },
    SES_WAIT_MS * 3 + 60_000,
  );
});
