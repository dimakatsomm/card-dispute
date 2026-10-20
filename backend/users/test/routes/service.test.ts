import { zGetUserContactResponse, zListCardsForUserResponse } from '@cd/contracts/users.service';
import type { Servers } from '@cd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { bearer, buildTestServers, keysDeep, serviceToken, userToken } from '../helpers/app.ts';
import { expectContract } from '../helpers/contract.ts';
import { startUsersDb, type TestDb } from '../helpers/db.ts';
import { accountAt, CARD_TOKEN_PREFIX, cardIdsOf, seedFixture, type Fixture } from '../helpers/fixture.ts';

type CardsBody = z.output<typeof zListCardsForUserResponse>;

const UNKNOWN_USER = '0192f0c1-0000-7000-8000-00000000dead';

let db: TestDb;
let fx: Fixture;
let servers: Servers;

beforeAll(async () => {
  db = await startUsersDb();
  fx = await seedFixture(db.seedPool);
  servers = buildTestServers(db.appPool, {
    'hdr.token-user-a.signature': userToken(fx.a.userId),
    'hdr.token-cards.signature': serviceToken(['auth/validate', 'users/cards.read']),
    'hdr.token-contact.signature': serviceToken(['users/contact.read']),
  });
});

afterAll(async () => {
  await servers?.close();
  await db?.stop();
});

const get = (url: string, token?: string) =>
  servers.service.inject({ method: 'GET', url, ...(token === undefined ? {} : { headers: bearer(token) }) });

const cards = async (query: string): Promise<CardsBody['cards']> => {
  const res = await get(`/cards?${query}`, 'hdr.token-cards.signature');
  expect(res.statusCode).toBe(200);
  return res.json<CardsBody>().cards;
};

describe('service port guard', () => {
  it('rejects a missing token with 401 on every service route while /health stays open', async () => {
    expect((await get(`/cards?userId=${fx.a.userId}`)).statusCode).toBe(401);
    expect((await get(`/users/${fx.a.userId}/contact`)).statusCode).toBe(401);
    expect((await get('/health')).statusCode).toBe(200);
  });

  it('does not register /me on the service port', async () => {
    expect((await get('/me', 'hdr.token-user-a.signature')).statusCode).toBe(404);
  });
});

describe('GET /cards (service port)', () => {
  it.each([
    ['a user token', 'hdr.token-user-a.signature'],
    ['a service token without users/cards.read', 'hdr.token-contact.signature'],
  ])('rejects %s with 403', async (_name, token) => {
    expect((await get(`/cards?userId=${fx.a.userId}`, token)).statusCode).toBe(403);
  });

  it("rejects a user token asking for another user's cards with 403 and no card data", async () => {
    const res = await get(`/cards?userId=${fx.b.userId}`, 'hdr.token-user-a.signature');

    expect(res.statusCode).toBe(403);
    expect(keysDeep(res.json())).not.toContain('cards');
    for (const id of cardIdsOf(fx.b)) expect(res.body).not.toContain(id);
  });

  it('with users/cards.read returns only that user’s cards, with userId and expired and never the token', async () => {
    const res = await get(`/cards?userId=${fx.a.userId}`, 'hdr.token-cards.signature');

    expect(res.statusCode).toBe(200);
    const body = expectContract(zListCardsForUserResponse, res);
    expect(body.cards.map((c) => [c.cardId, c.userId, c.expired])).toEqual([
      [cardIdsOf(fx.a)[0], fx.a.userId, true],
      [cardIdsOf(fx.a)[1], fx.a.userId, false],
      [cardIdsOf(fx.a)[2], fx.a.userId, false],
    ]);
    expect(keysDeep(res.json())).not.toContain('token');
    expect(res.body).not.toContain(CARD_TOKEN_PREFIX);
  });

  it('filters by accountId and by cardId', async () => {
    const second = accountAt(fx.a, 1);
    expect((await cards(`userId=${fx.a.userId}&accountId=${second.accountId}`)).map((c) => c.cardId)).toEqual(
      second.cardIds,
    );
    const [firstCard] = cardIdsOf(fx.a);
    expect((await cards(`userId=${fx.a.userId}&cardId=${firstCard}`)).map((c) => c.cardId)).toEqual([firstCard]);
  });

  it("returns nothing when the account or card belongs to a different user than userId", async () => {
    const bAccount = accountAt(fx.b, 0);
    expect(await cards(`userId=${fx.a.userId}&accountId=${bAccount.accountId}`)).toEqual([]);
    expect(await cards(`userId=${fx.a.userId}&cardId=${bAccount.cardIds[0]}`)).toEqual([]);
    expect(await cards(`userId=${UNKNOWN_USER}`)).toEqual([]);
  });

  it.each([
    ['userId missing', ''],
    ['userId not a uuid', 'userId=not-a-uuid'],
    ['accountId not a uuid', `userId=${UNKNOWN_USER}&accountId=1`],
  ])('returns 400 when %s', async (_name, query) => {
    const res = await get(`/cards?${query}`, 'hdr.token-cards.signature');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('GET /users/{userId}/contact (service port)', () => {
  it.each([
    ['a user token', 'hdr.token-user-a.signature'],
    ['a service token with only users/cards.read', 'hdr.token-cards.signature'],
  ])('rejects %s with 403 (requires users/contact.read)', async (_name, token) => {
    expect((await get(`/users/${fx.a.userId}/contact`, token)).statusCode).toBe(403);
  });

  it('returns userId, email and name for a known user', async () => {
    const res = await get(`/users/${fx.b.userId}/contact`, 'hdr.token-contact.signature');

    expect(res.statusCode).toBe(200);
    expect(expectContract(zGetUserContactResponse, res)).toEqual({
      userId: fx.b.userId,
      email: 'sipho@example.com',
      name: 'Sipho',
    });
  });

  it('returns 404 when the userId is unknown', async () => {
    const res = await get(`/users/${UNKNOWN_USER}/contact`, 'hdr.token-contact.signature');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 400 when the userId is not a uuid, as the spec says', async () => {
    const res = await get('/users/not-a-uuid/contact', 'hdr.token-contact.signature');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
