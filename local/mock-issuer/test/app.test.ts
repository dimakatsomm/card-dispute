import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SEED_USERS, loadConfig } from '../src/config.ts';

const REDIRECT = 'http://localhost:5173/callback';
const VERIFIER = 'v'.repeat(64);
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

const setup = (env: NodeJS.ProcessEnv = {}, now: () => Date = () => new Date()) => {
  const config = loadConfig({
    MOCK_ISSUER_CLIENT_SECRET: 'test-secret',
    MOCK_ISSUER_SPA_REDIRECT_URIS: `http://localhost:5173/,${REDIRECT}`,
    ...env,
  });
  return { config, app: buildApp(config, { now }) };
};

const decode = (jwt: string) => {
  const [h, p, s] = jwt.split('.') as [string, string, string];
  return {
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
    claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
  };
};

const login = async (app: ReturnType<typeof setup>['app'], user: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/oauth2/authorize?response_type=code&client_id=spa&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challengeOf(VERIFIER)}&code_challenge_method=S256&state=xyz&login_as=${user}`,
  });
  return new URL(res.headers.location as string);
};

const exchange = (
  app: ReturnType<typeof setup>['app'],
  code: string,
  verifier: string,
  redirectUri = REDIRECT,
) =>
  app.inject({
    method: 'POST',
    url: '/oauth2/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'spa',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });

const clientCredentials = (app: ReturnType<typeof setup>['app'], clientId: string, scope?: string) =>
  app.inject({
    method: 'POST',
    url: '/oauth2/token',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basic(clientId, 'test-secret'),
    },
    payload: new URLSearchParams({
      grant_type: 'client_credentials',
      ...(scope ? { scope } : {}),
    }).toString(),
  });

describe('discovery', () => {
  it('advertises the issuer, JWKS and S256 PKCE', async () => {
    const { app, config } = setup();
    const doc = (await app.inject({ url: '/.well-known/openid-configuration' })).json();
    expect(doc).toMatchObject({
      issuer: config.issuer,
      jwks_uri: `${config.issuer}/.well-known/jwks.json`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('stable signing key', () => {
  it('loads an escaped PEM to the same JWKS kid every time', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const escaped = pem.replaceAll('\n', '\\n');
    const kid = async () =>
      (
        (
          await setup({ MOCK_ISSUER_PRIVATE_KEY_PEM: escaped }).app.inject({ url: '/.well-known/jwks.json' })
        ).json() as {
          keys: { kid: string }[];
        }
      ).keys[0]?.kid;
    expect(await kid()).toBeDefined();
    expect(await kid()).toBe(await kid());
  });
});

describe('authorization code + PKCE', () => {
  it('issues Cognito-shaped user tokens that verify against the JWKS', async () => {
    const { app, config } = setup();
    const redirect = await login(app, 'A');
    expect(redirect.searchParams.get('state')).toBe('xyz');

    const res = await exchange(app, redirect.searchParams.get('code') as string, VERIFIER);
    expect(res.statusCode).toBe(200);
    const { access_token } = res.json() as { access_token: string };

    const jwks = (await app.inject({ url: '/.well-known/jwks.json' })).json() as {
      keys: ({ kid: string } & object)[];
    };
    const { signingInput, signature, claims } = decode(access_token);
    const key = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' });
    expect(verify('RSA-SHA256', Buffer.from(signingInput), key, signature)).toBe(true);
    expect(claims).toMatchObject({
      sub: SEED_USERS[0]?.sub,
      username: SEED_USERS[0]?.username,
      token_use: 'access',
      client_id: 'spa',
      iss: config.issuer,
    });
    expect(claims['exp']).toBeGreaterThan(claims['iat'] as number);
  });

  it('rejects a mismatched PKCE verifier and burns the code', async () => {
    const { app } = setup();
    const code = (await login(app, 'B')).searchParams.get('code') as string;

    const bad = await exchange(app, code, 'w'.repeat(64));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_grant' });

    const retry = await exchange(app, code, VERIFIER);
    expect(retry.statusCode).toBe(400);
  });

  it('rejects a code older than its TTL', async () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const { app } = setup({}, () => clock);
    const code = (await login(app, 'A')).searchParams.get('code') as string;
    clock = new Date(clock.getTime() + 61_000);
    expect((await exchange(app, code, VERIFIER)).statusCode).toBe(400);
  });

  it('rejects a redirect_uri that differs from the authorize request', async () => {
    const { app } = setup();
    const code = (await login(app, 'A')).searchParams.get('code') as string;
    const res = await exchange(app, code, VERIFIER, 'http://localhost:5173/');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses to redirect to an unregistered redirect_uri', async () => {
    const { app } = setup();
    const res = await app.inject({
      url: `/oauth2/authorize?response_type=code&client_id=spa&redirect_uri=${encodeURIComponent('http://evil.example/')}&code_challenge=abc&code_challenge_method=S256&login_as=A`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });
});

const GRANTS_PER_DOCS_05: Readonly<Record<string, string>> = {
  'svc-users': 'auth/validate',
  'svc-transactions': 'auth/validate users/cards.read disputes/read',
  'svc-disputes': 'auth/validate users/cards.read transactions/read',
  'svc-notifier': 'users/contact.read',
  'svc-evidence-intake': 'disputes/evidence.write',
  'svc-backoffice': 'disputes/review disputes/resolve users/cards.read',
};

describe('client_credentials', () => {
  it.each(Object.entries(GRANTS_PER_DOCS_05))(
    'grants %s exactly its docs/05 scopes',
    async (clientId, scope) => {
      const { app } = setup();
      const res = await clientCredentials(app, clientId);
      expect(res.statusCode).toBe(200);
      expect(decode((res.json() as { access_token: string }).access_token).claims['scope']).toBe(scope);
    },
  );

  it('answers malformed Basic credentials with invalid_client', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/oauth2/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('%E0%A4%A:x').toString('base64')}`,
      },
      payload: 'grant_type=client_credentials',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns exactly the scopes allowed for the client', async () => {
    const { app } = setup();
    const res = await clientCredentials(app, 'svc-transactions');
    expect(res.statusCode).toBe(200);
    const { claims } = decode((res.json() as { access_token: string }).access_token);
    expect(claims).toMatchObject({
      client_id: 'svc-transactions',
      token_use: 'access',
      scope: 'auth/validate users/cards.read disputes/read',
    });
    expect(claims).not.toHaveProperty('sub');
  });

  it('rejects scopes the client is not allowed and wrong secrets', async () => {
    const { app } = setup();
    const tooMuch = await clientCredentials(app, 'svc-notifier', 'users/contact.read disputes/resolve');
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json()).toMatchObject({ error: 'invalid_scope' });

    const wrongSecret = await app.inject({
      method: 'POST',
      url: '/oauth2/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic('svc-notifier', 'nope'),
      },
      payload: 'grant_type=client_credentials',
    });
    expect(wrongSecret.statusCode).toBe(401);
  });
});

describe('test hooks', () => {
  it('are 404 unless MOCK_ISSUER_TEST_HOOKS=true', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/test/tokens?variant=expired' })).statusCode).toBe(404);
  });

  it('mint expired, wrong-issuer and id tokens when enabled', async () => {
    const { app, config } = setup({ MOCK_ISSUER_TEST_HOOKS: 'true' });
    const mint = async (query: string) =>
      decode(
        ((await app.inject({ url: `/test/tokens?${query}` })).json() as { access_token: string })
          .access_token,
      ).claims;

    const expired = await mint('variant=expired');
    expect(expired['exp'] as number).toBeLessThan(Date.now() / 1000);

    const wrongIssuer = await mint('variant=wrong_issuer&user=B');
    expect(wrongIssuer['iss']).not.toBe(config.issuer);
    expect(wrongIssuer['sub']).toBe(SEED_USERS[1]?.sub);

    expect((await mint('variant=id'))['token_use']).toBe('id');

    const badSig = (await app.inject({ url: '/test/tokens?variant=bad_signature' })).json() as {
      access_token: string;
    };
    const jwks = (await app.inject({ url: '/.well-known/jwks.json' })).json() as { keys: object[] };
    const { signingInput, signature } = decode(badSig.access_token);
    const key = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' });
    expect(verify('RSA-SHA256', Buffer.from(signingInput), key, signature)).toBe(false);
  });
});

describe('CORS', () => {
  const ORIGIN = 'http://localhost:5173';
  const { app } = setup({ MOCK_ISSUER_CORS_ORIGINS: ORIGIN });
  const requests = [
    { method: 'GET', url: '/.well-known/openid-configuration' },
    { method: 'GET', url: '/.well-known/jwks.json' },
    { method: 'POST', url: '/oauth2/token' },
  ] as const;

  it('echoes an allowed origin on discovery, JWKS, token and the token preflight', async () => {
    for (const r of requests) {
      const res = await app.inject({ ...r, headers: { origin: ORIGIN } });
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(res.headers['vary']).toBe('Origin');
    }
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/oauth2/token',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type, authorization');
  });

  it('sends no allow-origin to a disallowed origin', async () => {
    for (const r of requests) {
      const res = await app.inject({ ...r, headers: { origin: 'http://evil.example' } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
