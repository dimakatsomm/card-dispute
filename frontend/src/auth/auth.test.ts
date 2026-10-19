import { describe, expect, it, vi } from 'vitest';
import { createAuth, safeReturnTo } from './auth';

const issuer = 'https://issuer.test';
const redirectUri = 'http://localhost:3000/auth/callback';
const accessToken = 'access-token-value';
const refreshToken = 'refresh-token-value';

const settings = {
  issuer,
  clientId: 'web-client',
  redirectUri,
  logoutUrl: `${issuer}/logout`,
  postLogoutUri: 'http://localhost:3000/',
};

const base64url = (value: object): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const idToken = [
  base64url({ alg: 'RS256', typ: 'JWT' }),
  base64url({ sub: 'user-a', iss: issuer, aud: 'web-client', exp: 4_102_444_800, iat: 1_760_000_000 }),
  'signature',
].join('.');

const json = (body: object): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const stubIssuer = (): ReadonlyArray<string> => {
  const tokenRequests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
      }
      if (url === `${issuer}/token`) {
        tokenRequests.push(String(init?.body));
        return json({
          access_token: accessToken,
          id_token: idToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 900,
          scope: 'openid',
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return tokenRequests;
};

const storageKeys = (storage: Storage): ReadonlyArray<string> =>
  Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? '');

const storedValues = (storage: Storage): string =>
  storageKeys(storage)
    .map((key) => storage.getItem(key) ?? '')
    .join('\n');

const redirectStateKey = (): string | undefined => storageKeys(sessionStorage).find((k) => k.startsWith('oidc.'));

const signInThroughCallback = async () => {
  const tokenRequests = stubIssuer();
  const navigate = vi.fn<(url: string) => void>();
  const auth = createAuth(settings, { redirectStateStorage: window.sessionStorage, navigate });
  // The redirect never resolves (it navigates away); only the stored PKCE state matters here.
  void auth.signIn('/disputes');
  const stateKey = await vi.waitFor(() => {
    const key = redirectStateKey();
    if (!key) throw new Error('no redirect state yet');
    return key;
  });
  const state = stateKey.slice('oidc.'.length);
  const result = await auth.completeSignIn(`${redirectUri}?code=auth-code&state=${state}`);
  return { auth, navigate, result, tokenRequests };
};

describe('auth: OIDC authorization code + PKCE, tokens in memory only', () => {
  it('redeems the code with a PKCE verifier and returns to the requested page', async () => {
    const { result, tokenRequests } = await signInThroughCallback();

    expect(result).toEqual({ ok: true, value: '/disputes' });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatch(/code_verifier=[\w-]{43,}/);
  });

  it('keeps tokens out of localStorage and sessionStorage', async () => {
    const { auth } = await signInThroughCallback();

    expect(await auth.getAccessToken()).toBe(accessToken);
    expect(localStorage.length).toBe(0);
    expect(storedValues(sessionStorage)).not.toContain(accessToken);
    expect(storedValues(sessionStorage)).not.toContain(refreshToken);
  });

  it('rejects a callback whose state it never issued', async () => {
    stubIssuer();
    const auth = createAuth(settings, { redirectStateStorage: window.sessionStorage, navigate: vi.fn() });

    expect(await auth.completeSignIn(`${redirectUri}?code=auth-code&state=forged`)).toEqual({
      ok: false,
      error: 'SIGNIN_FAILED',
    });
    expect(await auth.getAccessToken()).toBeNull();
  });

  it('signs out at the IdP without starting a new sign-in and leaves no token', async () => {
    const { auth, navigate } = await signInThroughCallback();
    const listener = vi.fn();
    auth.onChange(listener);

    await auth.signOut();
    await auth.signIn('/');

    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      `${issuer}/logout?client_id=web-client&logout_uri=${encodeURIComponent('http://localhost:3000/')}`,
    );
    expect(listener).not.toHaveBeenCalledWith(null);
    expect(redirectStateKey()).toBeUndefined();
    expect(await auth.getAccessToken()).toBeNull();
    expect(storedValues(sessionStorage)).not.toContain(accessToken);
  });

  it('refreshes an expired session once for concurrent callers', async () => {
    const { auth, tokenRequests } = await signInThroughCallback();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });

    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    vi.useRealTimers();

    expect(tokens).toEqual([accessToken, accessToken, accessToken]);
    const refreshes = tokenRequests.filter((body) => body.includes('grant_type=refresh_token'));
    expect(refreshes).toHaveLength(1);
  });
});

describe('safeReturnTo: only same-origin paths survive the redirect', () => {
  it.each([
    ['/disputes?status=SUBMITTED', '/disputes?status=SUBMITTED'],
    ['/', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/disputes\\..\\evil', '/'],
    ['https://evil.example', '/'],
    ['disputes', '/'],
  ])('%s → %s', (returnTo, expected) => {
    expect(safeReturnTo({ returnTo })).toBe(expected);
  });

  it('falls back to / when the state carries no path', () => {
    expect(safeReturnTo(undefined)).toBe('/');
  });
});
