import { ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import { createAuthClient } from '../src/auth-client.ts';
import { createServiceTokenProvider } from '../src/service-token.ts';
import { AUTH_ID, fakeFetch, invalidResult, jsonResponse, USER_ID, userPrincipal } from './fakes.ts';

const T0 = 1_800_000_000_000;
const secs = (n: number) => n * 1000;
const epoch = (ms: number) => Math.floor(ms / 1000);

const setup = (respond: () => Response) => {
  const clock = { now: T0 };
  const stub = fakeFetch(respond);
  const client = createAuthClient({
    authUrl: 'http://auth:8081',
    fetch: stub.fetch,
    now: () => clock.now,
    getServiceToken: async () => ok('service-token'),
  });
  return { clock, stub, client };
};

describe('createAuthClient.validate', () => {
  it('calls POST /validate with the service token and the subject token in the body', async () => {
    const { stub, client } = setup(() => jsonResponse(200, userPrincipal(epoch(T0) + 900)));
    const result = await client.validate('user-jwt', 'corr-12345678');
    expect(result).toEqual({
      ok: true,
      value: { principalType: 'user', authId: AUTH_ID, userId: USER_ID, scopes: [], exp: epoch(T0) + 900 },
    });
    expect(stub.calls[0]).toMatchObject({ url: 'http://auth:8081/validate', method: 'POST' });
    expect(stub.calls[0]?.headers['authorization']).toBe('Bearer service-token');
    expect(stub.calls[0]?.headers['x-correlation-id']).toBe('corr-12345678');
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({ token: 'user-jwt' });
  });

  it('serves a repeated valid token from cache without a request', async () => {
    const { stub, client } = setup(() => jsonResponse(200, userPrincipal(epoch(T0) + 900)));
    await client.validate('user-jwt');
    await client.validate('user-jwt');
    expect(stub.calls).toHaveLength(1);
    await client.validate('other-jwt');
    expect(stub.calls).toHaveLength(2);
  });

  it('single-flights concurrent validations of the same token', async () => {
    const { stub, client } = setup(() => jsonResponse(200, userPrincipal(epoch(T0) + 900)));
    await Promise.all(Array.from({ length: 10 }, () => client.validate('user-jwt')));
    expect(stub.calls).toHaveLength(1);
  });

  it('caches for 60s when the token outlives that', async () => {
    const { clock, stub, client } = setup(() => jsonResponse(200, userPrincipal(epoch(T0) + 900)));
    await client.validate('user-jwt');
    clock.now = T0 + secs(59);
    await client.validate('user-jwt');
    expect(stub.calls).toHaveLength(1);
    clock.now = T0 + secs(61);
    await client.validate('user-jwt');
    expect(stub.calls).toHaveLength(2);
  });

  it('caches only until exp when exp is sooner than 60s', async () => {
    const { clock, stub, client } = setup(() => jsonResponse(200, userPrincipal(epoch(T0) + 10)));
    await client.validate('user-jwt');
    clock.now = T0 + secs(9);
    await client.validate('user-jwt');
    expect(stub.calls).toHaveLength(1);
    clock.now = T0 + secs(11);
    await client.validate('user-jwt');
    expect(stub.calls).toHaveLength(2);
  });

  it('never caches an invalid result', async () => {
    const { stub, client } = setup(() => jsonResponse(200, invalidResult('expired')));
    const first = await client.validate('bad-jwt');
    await client.validate('bad-jwt');
    expect(first).toEqual({ ok: false, error: { kind: 'invalid', reason: 'expired' } });
    expect(stub.calls).toHaveLength(2);
  });

  it('maps a 400 from auth to invalid, not unavailable', async () => {
    const { client } = setup(() => jsonResponse(400, { code: 'VALIDATION_ERROR' }));
    expect(await client.validate('user-jwt')).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it.each([
    ['5xx', () => jsonResponse(500, {})],
    ['401 for our own service token', () => jsonResponse(401, {})],
    ['a non-uuid userId', () => jsonResponse(200, { ...userPrincipal(epoch(T0) + 900), userId: 'user-1' })],
    ['a fractional exp', () => jsonResponse(200, userPrincipal(epoch(T0) + 900.5))],
    ['valid:false without principalType none', () => jsonResponse(200, { valid: false, reason: 'expired' })],
    ['non-JSON body', () => new Response('<html>', { status: 200 })],
  ])('treats %s as unavailable and does not cache', async (_name, respond) => {
    const { client } = setup(respond);
    expect(await client.validate('user-jwt')).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });

  it('treats an unreachable auth service as unavailable', async () => {
    const client = createAuthClient({
      authUrl: 'http://auth:8081',
      fetch: async () => Promise.reject(new Error('ECONNREFUSED')),
      now: () => T0,
      getServiceToken: async () => ok('service-token'),
    });
    expect(await client.validate('user-jwt')).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });

  it('treats a failing service-token provider as unavailable', async () => {
    const stub = fakeFetch(() => jsonResponse(200, userPrincipal(epoch(T0) + 900)));
    const client = createAuthClient({
      authUrl: 'http://auth:8081',
      fetch: stub.fetch,
      now: () => T0,
      getServiceToken: async () => ({ ok: false, error: { kind: 'token_unavailable', detail: 'issuer down' } }),
    });
    expect(await client.validate('user-jwt')).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('createAuthClient service-token rejection', () => {
  const build = (authRespond: (bearer: string | undefined, call: number) => Response) => {
    const clock = { now: T0 };
    let issued = 0;
    const tokenStub = fakeFetch(() => jsonResponse(200, { access_token: `svc-${++issued}`, expires_in: 3600 }));
    const provider = createServiceTokenProvider({
      tokenUrl: 'http://issuer/oauth2/token',
      clientId: 'svc',
      clientSecret: 'secret',
      scopes: ['auth/validate'],
      fetch: tokenStub.fetch,
      now: () => clock.now,
    });
    let calls = 0;
    const authStub = fakeFetch((call) => authRespond(call.headers['authorization'], ++calls));
    const client = createAuthClient({
      authUrl: 'http://auth:8081',
      fetch: authStub.fetch,
      now: () => clock.now,
      getServiceToken: provider.getToken,
      invalidateServiceToken: provider.invalidate,
    });
    return { clock, tokenStub, authStub, client };
  };
  const principal = () => jsonResponse(200, userPrincipal(epoch(T0) + 900));

  it('refetches the service token once when auth rejects it, then succeeds', async () => {
    const { tokenStub, authStub, client } = build((bearer) => (bearer === 'Bearer svc-1' ? jsonResponse(401, {}) : principal()));
    expect(await client.validate('user-jwt')).toMatchObject({ ok: true });
    expect(tokenStub.calls).toHaveLength(2);
    expect(authStub.calls.map((c) => c.headers['authorization'])).toEqual(['Bearer svc-1', 'Bearer svc-2']);
  });

  it('is unavailable after a second 401 and does not retry again', async () => {
    const { tokenStub, authStub, client } = build(() => jsonResponse(401, {}));
    expect(await client.validate('user-jwt')).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(tokenStub.calls).toHaveLength(2);
    expect(authStub.calls).toHaveLength(2);
  });

  it('N concurrent validations rejected with the same old token cause exactly one forced refetch', async () => {
    const { tokenStub, client } = build((bearer) => (bearer === 'Bearer svc-1' ? jsonResponse(401, {}) : principal()));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => client.validate(`user-jwt-${i}`)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(tokenStub.calls).toHaveLength(2);
  });

  it('a sustained 401 forces at most one refetch per cooldown window', async () => {
    const { clock, tokenStub, client } = build(() => jsonResponse(401, {}));
    for (let i = 0; i < 5; i++) await client.validate(`user-jwt-${i}`);
    expect(tokenStub.calls).toHaveLength(2);
    clock.now = T0 + secs(11);
    for (let i = 5; i < 10; i++) await client.validate(`user-jwt-${i}`);
    expect(tokenStub.calls).toHaveLength(3);
  });

  it.each([
    ['valid:false answers', () => jsonResponse(200, invalidResult('expired'))],
    ['400 answers', () => jsonResponse(400, {})],
  ])('many distinct tokens rejected as %s never refetch the service token', async (_name, respond) => {
    const { tokenStub, client } = build(respond);
    for (let i = 0; i < 10; i++) await client.validate(`user-jwt-${i}`);
    expect(tokenStub.calls).toHaveLength(1);
  });

  it("one caller's abort returns early without cancelling the shared lookup for the others", async () => {
    const { authStub, client } = build(() => principal());
    const impatient = new AbortController();
    const early = client.validate('user-jwt', undefined, impatient.signal);
    const patient = client.validate('user-jwt');
    impatient.abort();
    expect(await early).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(await patient).toMatchObject({ ok: true });
    expect(authStub.calls).toHaveLength(1);
  });
});
