import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import { allPassed, probeDenials, probeUnreachable, tokenError, type Fetch, type ProbeDeps } from '../src/probe.ts';
import { serviceTokenVia, userTokenVia } from '../src/probe-tokens.ts';
import { encodeSeedUserSecret } from '../src/seed-user-secret.ts';
import { fakeAws } from './fake-aws.ts';

const BASE = 'http://internal-cd-alb.example.com:8081';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '22222222-2222-4222-8222-222222222222';

type Seen = { readonly method: string; readonly url: string; readonly auth: string | undefined };

// A service port that behaves like ours: no token 401, wrong principal or scope 403.
const servicePort = (seen: Seen[], answer = (s: Seen): number => (s.auth === undefined ? 401 : 403)): Fetch => async (url, init) => {
  const headers = init.headers as Record<string, string>;
  const s = { method: init.method ?? 'GET', url, auth: headers.authorization };
  seen.push(s);
  return { status: answer(s) };
};

const deps = (fetch: Fetch, overrides: Partial<ProbeDeps> = {}): ProbeDeps => ({
  fetch,
  timeoutMs: 50,
  userToken: async () => ok('user-tok'),
  serviceToken: async () => ok('svc-tok'),
  ...overrides,
});

const targets = { serviceBaseUrl: `${BASE}/`, userId: USER_ID, unknownId: () => UNKNOWN };

const withCode = (code: string): Error => Object.assign(new Error(code), { code });
// The shape undici's fetch rejects with: a bare TypeError whose cause carries the socket or DNS code.
const fetchFailed = (code: string): TypeError => new TypeError('fetch failed', { cause: withCode(code) });
const rejectWith = (e: Error): Fetch => async () => Promise.reject(e);

describe('probe mode B (denials)', () => {
  it('passes when no token gets 401, the user token gets 403 on /disputes and svc-notifier gets 403 on PUT evidence', async () => {
    const seen: Seen[] = [];
    const result = await probeDenials(deps(servicePort(seen)))(targets);
    expect(result.ok && allPassed(result.value)).toBe(true);
    expect(seen).toEqual([
      { method: 'GET', url: `${BASE}/disputes?userId=${USER_ID}&transactionIds=${UNKNOWN}`, auth: undefined },
      { method: 'GET', url: `${BASE}/disputes?userId=${USER_ID}&transactionIds=${UNKNOWN}`, auth: 'Bearer user-tok' },
      { method: 'PUT', url: `${BASE}/dispute/${UNKNOWN}/evidence/${UNKNOWN}`, auth: 'Bearer svc-tok' },
    ]);
  });

  it.each([
    ['the user token is let through (200)', (s: Seen) => (s.auth === 'Bearer user-tok' ? 200 : s.auth ? 403 : 401)],
    ['svc-notifier reaches the evidence route (404)', (s: Seen) => (s.method === 'PUT' ? 404 : s.auth ? 403 : 401)],
    ['an anonymous call is answered 403 instead of 401', () => 403],
  ])('fails when %s', async (_, answer) => {
    const result = await probeDenials(deps(servicePort([], answer)))(targets);
    expect(result.ok && allPassed(result.value)).toBe(false);
  });

  it('fails when the service port does not answer at all', async () => {
    const result = await probeDenials(deps(rejectWith(fetchFailed('ECONNREFUSED'))))(targets);
    expect(result.ok && result.value.map((r) => r.observed)).toEqual(['unreachable', 'unreachable', 'unreachable']);
    expect(result.ok && allPassed(result.value)).toBe(false);
  });

  it('reports a token failure without calling the service port', async () => {
    const seen: Seen[] = [];
    const result = await probeDenials(deps(servicePort(seen), { serviceToken: async () => tokenError('service', 'token endpoint status 400') }))(targets);
    expect(result).toEqual({ ok: false, error: { kind: 'token', which: 'service', reason: 'token endpoint status 400' } });
    expect(seen).toEqual([]);
  });

  it('results carry only check names and status codes, never a token', async () => {
    const result = await probeDenials(deps(servicePort([])))(targets);
    expect(JSON.stringify(result)).not.toMatch(/user-tok|svc-tok/);
  });
});

describe('probe mode A (--expect-unreachable)', () => {
  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])('passes when undici fails with %s', async (code) => {
    const results = await probeUnreachable(deps(rejectWith(fetchFailed(code))))([BASE]);
    expect(results).toEqual([{ check: `unreachable ${BASE}`, expected: 'unreachable', observed: 'unreachable', code, pass: true }]);
  });

  it('passes on a refusal reported through an AggregateError (dual-stack connect) and on a timeout', async () => {
    const aggregate = new TypeError('fetch failed', { cause: new AggregateError([withCode('ECONNREFUSED')]) });
    expect(allPassed(await probeUnreachable(deps(rejectWith(aggregate)))([BASE]))).toBe(true);
    const hanging: Fetch = (_, init) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    expect(await probeUnreachable(deps(hanging))([BASE])).toMatchObject([{ observed: 'unreachable', code: 'TimeoutError', pass: true }]);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])(
    'fails when the connection could not be attempted or verified (%s)',
    async (code) => {
      const results = await probeUnreachable(deps(rejectWith(fetchFailed(code))))([BASE]);
      expect(results).toEqual([{ check: `unreachable ${BASE}`, expected: 'unreachable', observed: 'error', code, pass: false }]);
    },
  );

  it('fails on an unexplained fetch error and on an invalid base URL without fetching', async () => {
    expect(await probeUnreachable(deps(rejectWith(new TypeError('fetch failed'))))([BASE])).toMatchObject([
      { observed: 'error', code: 'TypeError', pass: false },
    ]);
    const seen: Seen[] = [];
    const results = await probeUnreachable(deps(servicePort(seen)))(['not a url', 'ftp://alb.example.com:8081']);
    expect(results.map((r) => [r.observed, r.code, r.pass])).toEqual([
      ['error', 'ERR_INVALID_URL', false],
      ['error', 'ERR_INVALID_URL', false],
    ]);
    expect(seen).toEqual([]);
  });

  it('fails on any HTTP answer, even a 404', async () => {
    const results = await probeUnreachable(deps(async () => ({ status: 404 })))([BASE]);
    expect(results).toEqual([{ check: `unreachable ${BASE}`, expected: 'unreachable', observed: 404, code: null, pass: false }]);
    expect(allPassed([])).toBe(false);
  });

  it('classifies real undici errors: a closed local port passes, an unresolvable host fails', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const real = deps(fetch, { timeoutMs: 5_000 });
    expect(await probeUnreachable(real)([`http://127.0.0.1:${port}`])).toMatchObject([{ observed: 'unreachable', pass: true }]);
    const [dns] = await probeUnreachable(real)(['http://cd-probe-target.invalid:8081']);
    expect(dns).toMatchObject({ observed: 'error', pass: false });
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(dns?.code);
  });
});

describe('probe token sources', () => {
  it('gets the user token with ADMIN_USER_PASSWORD_AUTH on the e2e client using the seed-user secret', async () => {
    const aws = fakeAws();
    aws.users.set('thandi.nkosi', { sub: 'sub-a', enabled: true, status: 'CONFIRMED', password: 'Fake-Passw0rd-123!', email: 'thandi.nkosi@example.com' });
    aws.secrets.set('cd/dev/seed-users/thandi.nkosi', {
      value: encodeSeedUserSecret({ username: 'thandi.nkosi', password: 'Fake-Passw0rd-123!' }),
      kmsKeyId: undefined,
      tags: undefined,
    });
    const token = await userTokenVia({
      cognito: aws.cognito,
      secrets: aws.secretsManager,
      userPoolId: 'af-south-1_FAKEPOOL',
      clientId: 'e2e-client',
      secretId: 'cd/dev/seed-users/thandi.nkosi',
    })();
    expect(token).toEqual({ ok: true, value: 'user-token-sub-a' });
    expect(aws.calls.find((c) => c.command === 'AdminInitiateAuthCommand')?.input).toMatchObject({
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      ClientId: 'e2e-client',
      UserPoolId: 'af-south-1_FAKEPOOL',
    });
  });

  it('gets the service token with client_credentials and Basic auth at TOKEN_URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: 'svc-tok', token_type: 'Bearer' }), { status: 200 });
    }) as typeof fetch;
    const token = await serviceTokenVia({
      fetch: fakeFetch,
      tokenUrl: 'https://cd-dev.auth.af-south-1.amazoncognito.com/oauth2/token',
      clientId: 'svc-notifier-id',
      clientSecret: 'fake-secret',
      timeoutMs: 50,
    })();
    expect(token).toEqual({ ok: true, value: 'svc-tok' });
    expect(calls[0]?.init.body).toBe('grant_type=client_credentials');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('svc-notifier-id:fake-secret').toString('base64')}`,
    );
  });

  it.each(['http://cd-dev.auth.af-south-1.amazoncognito.com/oauth2/token', 'not a url'])(
    'refuses to send the client secret to a non-https TOKEN_URL (%s)',
    async (tokenUrl) => {
      const calls: string[] = [];
      const fakeFetch = (async (url: string) => {
        calls.push(url);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      const token = await serviceTokenVia({ fetch: fakeFetch, tokenUrl, clientId: 'id', clientSecret: 'fake-secret', timeoutMs: 50 })();
      expect(token).toEqual({ ok: false, error: { kind: 'token', which: 'service', reason: 'TOKEN_URL must be an https URL' } });
      expect(calls).toEqual([]);
    },
  );
});
