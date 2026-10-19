import { describe, expect, it } from 'vitest';
import { createServiceTokenProvider } from '../src/service-token.ts';
import { fakeFetch, jsonResponse } from './fakes.ts';

const T0 = 1_800_000_000_000;

const setup = (respond?: () => Response) => {
  const clock = { now: T0 };
  let issued = 0;
  const stub = fakeFetch(
    respond ?? (() => jsonResponse(200, { access_token: `token-${++issued}`, expires_in: 3600, token_type: 'Bearer' })),
  );
  const provider = createServiceTokenProvider({
    tokenUrl: 'http://issuer/oauth2/token',
    clientId: 'svc-a',
    clientSecret: 's3cret',
    scopes: ['auth/validate', 'users/cards.read'],
    fetch: stub.fetch,
    now: () => clock.now,
  });
  return { clock, stub, provider };
};

describe('createServiceTokenProvider', () => {
  it('makes exactly one token request for N concurrent calls', async () => {
    const { stub, provider } = setup();
    const results = await Promise.all(Array.from({ length: 25 }, () => provider.getToken()));
    expect(stub.calls).toHaveLength(1);
    expect(results.every((r) => r.ok && r.value === 'token-1')).toBe(true);
  });

  it('sends client_credentials with Basic auth and the requested scopes', async () => {
    const { stub, provider } = setup();
    await provider.getToken();
    const call = stub.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.headers['authorization']).toBe(`Basic ${Buffer.from('svc-a:s3cret').toString('base64')}`);
    const form = new URLSearchParams(call?.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('auth/validate users/cards.read');
  });

  it('serves from cache until 60s before expiry, then refreshes', async () => {
    const { clock, stub, provider } = setup();
    await provider.getToken();
    clock.now = T0 + 3539_000;
    expect(await provider.getToken()).toEqual({ ok: true, value: 'token-1' });
    expect(stub.calls).toHaveLength(1);
    clock.now = T0 + 3541_000;
    expect(await provider.getToken()).toEqual({ ok: true, value: 'token-2' });
    expect(stub.calls).toHaveLength(2);
  });

  it('form-urlencodes id and secret before Basic encoding (RFC 6749 s2.3.1)', async () => {
    const stub = fakeFetch(() => jsonResponse(200, { access_token: 't', expires_in: 3600 }));
    const provider = createServiceTokenProvider({
      tokenUrl: 'http://issuer/oauth2/token',
      clientId: 'svc a',
      clientSecret: 'p+w%d:x y',
      scopes: [],
      fetch: stub.fetch,
      now: () => T0,
    });
    await provider.getToken();
    const encoded = (stub.calls[0]?.headers['authorization'] ?? '').replace('Basic ', '');
    expect(Buffer.from(encoded, 'base64').toString()).toBe('svc+a:p%2Bw%25d%3Ax+y');
  });

  it('refetches after a failure, then caches the success', async () => {
    let attempts = 0;
    const { stub, provider } = setup(() =>
      ++attempts === 1 ? jsonResponse(500, {}) : jsonResponse(200, { access_token: 'ok-token', expires_in: 3600 }),
    );
    expect((await provider.getToken()).ok).toBe(false);
    expect(await provider.getToken()).toEqual({ ok: true, value: 'ok-token' });
    await provider.getToken();
    expect(stub.calls).toHaveLength(2);
  });

  it('refreshes short-lived tokens at half their lifetime, not immediately', async () => {
    const { clock, stub, provider } = setup(() => jsonResponse(200, { access_token: 'short', expires_in: 30 }));
    await provider.getToken();
    clock.now = T0 + 14_000;
    await provider.getToken();
    expect(stub.calls).toHaveLength(1);
    clock.now = T0 + 16_000;
    await provider.getToken();
    expect(stub.calls).toHaveLength(2);
  });

  it.each([
    ['non-200', () => jsonResponse(401, { error: 'invalid_client' })],
    ['server error', () => jsonResponse(500, {})],
    ['unparseable', () => jsonResponse(200, { nope: true })],
  ])('returns an error on %s and does not cache it', async (_name, respond) => {
    const { stub, provider } = setup(respond);
    expect((await provider.getToken()).ok).toBe(false);
    expect((await provider.getToken()).ok).toBe(false);
    expect(stub.calls.length).toBeGreaterThanOrEqual(2);
  });
});
