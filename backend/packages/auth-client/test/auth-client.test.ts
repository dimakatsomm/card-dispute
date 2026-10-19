import { ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import { createAuthClient } from '../src/auth-client.ts';
import { fakeFetch, jsonResponse, userPrincipal } from './fakes.ts';

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
      value: { principalType: 'user', authId: 'auth-1', userId: 'user-1', scopes: [], exp: epoch(T0) + 900 },
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
    const { stub, client } = setup(() => jsonResponse(200, { valid: false, reason: 'expired' }));
    const first = await client.validate('bad-jwt');
    await client.validate('bad-jwt');
    expect(first).toEqual({ ok: false, error: { kind: 'invalid', reason: 'expired' } });
    expect(stub.calls).toHaveLength(2);
  });

  it.each([
    ['5xx', () => jsonResponse(500, {})],
    ['401 for our own service token', () => jsonResponse(401, {})],
    ['unparseable body', () => jsonResponse(200, { valid: true, principalType: 'alien' })],
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
