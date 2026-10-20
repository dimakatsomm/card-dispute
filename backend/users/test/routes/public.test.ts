import type { Servers } from '@cd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, buildTestServers, keysDeep, serviceToken, userToken } from '../helpers/app.ts';
import { startUsersDb, type TestDb } from '../helpers/db.ts';
import { accountAt, CARD_TOKEN_PREFIX, cardIdsOf, seedFixture, type Fixture } from '../helpers/fixture.ts';

type MeBody = {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly accounts: ReadonlyArray<{
    readonly accountId: string;
    readonly cards: ReadonlyArray<{ readonly cardId: string; readonly last4: string; readonly expired: boolean }>;
  }>;
};

let db: TestDb;
let fx: Fixture;
let servers: Servers;

beforeAll(async () => {
  db = await startUsersDb();
  fx = await seedFixture(db.seedPool);
  servers = buildTestServers(db.appPool, {
    'hdr.token-a.signature': userToken(fx.a.userId),
    'hdr.token-b.signature': userToken(fx.b.userId),
    'hdr.token-no-profile.signature': userToken('0192f0c1-0000-7000-8000-00000000dead'),
    'hdr.token-svc.signature': serviceToken(['users/cards.read', 'users/contact.read']),
  });
});

afterAll(async () => {
  await servers?.close();
  await db?.stop();
});

const me = (token: string) => servers.public.inject({ method: 'GET', url: '/me', headers: bearer(token) });

describe('GET /me (public port)', () => {
  it("returns the caller's profile, accounts and cards grouped by account, with no token key anywhere", async () => {
    const res = await me('hdr.token-a.signature');

    expect(res.statusCode).toBe(200);
    const body = res.json<MeBody>();
    expect(body).toMatchObject({ userId: fx.a.userId, name: 'Thandi', email: 'thandi@example.com' });
    expect(body.accounts.map((a) => ({ accountId: a.accountId, cardIds: a.cards.map((c) => c.cardId) }))).toEqual(
      fx.a.accounts.map((a) => ({ accountId: a.accountId, cardIds: a.cardIds })),
    );
    expect(keysDeep(body)).not.toContain('token');
    expect(res.body).not.toContain(CARD_TOKEN_PREFIX);
  });

  it("never includes another user's accounts or cards (user B sees only B)", async () => {
    const body = (await me('hdr.token-b.signature')).json<MeBody>();

    expect(body.userId).toBe(fx.b.userId);
    expect(body.accounts.map((a) => a.accountId)).toEqual([accountAt(fx.b, 0).accountId]);
    const returned = body.accounts.flatMap((a) => a.cards.map((c) => c.cardId));
    expect(returned).toEqual(cardIdsOf(fx.b));
    for (const id of cardIdsOf(fx.a)) expect(returned).not.toContain(id);
  });

  it('computes expired with isCardExpired and the injected clock: passed expiry month true, current month false', async () => {
    const cards = (await me('hdr.token-a.signature')).json<MeBody>().accounts.flatMap((a) => a.cards);

    expect(cards.map((c) => [c.last4, c.expired])).toEqual([
      ['1111', true],
      ['2222', false],
      ['3333', false],
    ]);
  });

  it('a user principal without a profile gets 404', async () => {
    const res = await me('hdr.token-no-profile.signature');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('public port guard', () => {
  it('rejects a missing token with 401 on /me while /health stays open', async () => {
    expect((await servers.public.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await servers.public.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('rejects a service token on /me with 403', async () => {
    expect((await me('hdr.token-svc.signature')).statusCode).toBe(403);
  });

  it.each(['/cards', `/users/0192f0c1-0000-7000-8000-000000000001/contact`])(
    'does not register service route %s on the public port, even for a scoped service token',
    async (url) => {
      const res = await servers.public.inject({ method: 'GET', url, headers: bearer('hdr.token-svc.signature') });
      expect(res.statusCode).toBe(404);
    },
  );
});
