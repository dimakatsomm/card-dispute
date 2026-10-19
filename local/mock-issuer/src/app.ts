import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SEED_USERS, generateKey } from './config.ts';
import type { Client, Config, SeedUser } from './config.ts';
import { accessTokenClaims, buildJwks, idTokenClaims, signJwt } from './tokens.ts';

export type Deps = { readonly now: () => Date };

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const CODE_TTL_SECONDS = 60;
const USER_SCOPE = 'openid profile email';
const OTHER_POOL_ISSUER = 'https://cognito-idp.af-south-1.amazonaws.com/af-south-1_otherpool';

type AuthCode = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly user: SeedUser;
  readonly scope: string;
  readonly nonce: string | null;
  readonly expiresAt: number;
};

type RefreshGrant = {
  readonly clientId: string;
  readonly user: SeedUser;
  readonly scope: string;
  readonly expiresAt: number;
};

type Params = Readonly<Record<string, string | undefined>>;

const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) =>
  reply.code(status).send({ error, ...(description ? { error_description: description } : {}) });

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const sha256b64url = (s: string): string => createHash('sha256').update(s).digest('base64url');

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const basicCredentials = (header: string | undefined): { id: string; secret: string } | null => {
  if (!header?.startsWith('Basic ')) return null;
  const [id, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  try {
    return id ? { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(':')) } : null;
  } catch {
    // Malformed percent-encoding is a client error, not a 500.
    return null;
  }
};

const loginPage = (params: Params): string => {
  const hidden = Object.entries(params)
    .filter(([k, v]) => v !== undefined && k !== 'login_as')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v ?? '')}">`)
    .join('');
  const buttons = SEED_USERS.map(
    (u) => `<button name="login_as" value="${u.key}">${u.key} - ${escapeHtml(u.label)}</button>`,
  ).join('<br>');
  return `<!doctype html><title>Mock sign-in</title><h1>Mock issuer sign-in</h1><form method="get" action="/oauth2/authorize">${hidden}${buttons}</form>`;
};

export const buildApp = (config: Config, deps: Deps): FastifyInstance => {
  const app = Fastify({ logger: false });
  const codes = new Map<string, AuthCode>();
  const refreshGrants = new Map<string, RefreshGrant>();
  const nowSeconds = () => Math.floor(deps.now().getTime() / 1000);
  const findClient = (id: string | undefined): Client | undefined =>
    config.clients.find((c) => c.clientId === id);
  const sign = (claims: Readonly<Record<string, unknown>>) => signJwt(config.privateKey, claims);

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth2/authorize`,
    token_endpoint: `${config.issuer}/oauth2/token`,
    end_session_endpoint: `${config.issuer}/logout`,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: ['openid', 'profile', 'email'],
  }));

  app.get('/.well-known/jwks.json', async () => buildJwks(config.privateKey));

  app.get('/logout', async (req, reply) => {
    const q = req.query as Params;
    const client = findClient(q['client_id']);
    const target = q['logout_uri'];
    if (!client || !target || !client.redirectUris.includes(target)) {
      return oauthError(reply, 400, 'invalid_request', 'unknown client or logout_uri');
    }
    return reply.redirect(target);
  });

  app.get('/oauth2/authorize', async (req, reply) => {
    const q = req.query as Params;
    const client = findClient(q['client_id']);
    const redirectUri = q['redirect_uri'];
    // An unregistered redirect_uri must never be redirected to, even with an error.
    if (!client || client.secret !== null || !redirectUri || !client.redirectUris.includes(redirectUri)) {
      return oauthError(reply, 400, 'invalid_request', 'unknown client or redirect_uri');
    }
    const back = (extra: Record<string, string>) => {
      const url = new URL(redirectUri);
      Object.entries({ ...extra, ...(q['state'] ? { state: q['state'] } : {}) }).forEach(([k, v]) =>
        url.searchParams.set(k, v),
      );
      return reply.redirect(url.toString());
    };
    if (q['response_type'] !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q['code_challenge'] || q['code_challenge_method'] !== 'S256') {
      return back({ error: 'invalid_request', error_description: 'PKCE S256 required' });
    }
    const user = SEED_USERS.find((u) => u.key === q['login_as']);
    if (!user) return reply.type('text/html').send(loginPage(q));
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      clientId: client.clientId,
      redirectUri,
      challenge: q['code_challenge'],
      user,
      scope: q['scope'] ?? USER_SCOPE,
      nonce: q['nonce'] ?? null,
      expiresAt: nowSeconds() + CODE_TTL_SECONDS,
    });
    return back({ code });
  });

  const userTokens = (
    client: Client,
    user: SeedUser,
    scope: string,
    nonce: string | null,
    refresh: string | null,
  ) => {
    const base = {
      issuer: config.issuer,
      clientId: client.clientId,
      nowSeconds: nowSeconds(),
      ttlSeconds: ACCESS_TTL_SECONDS,
    };
    return {
      access_token: sign(accessTokenClaims({ ...base, scope, sub: user.sub, username: user.username })),
      id_token: sign(idTokenClaims({ ...base, sub: user.sub, username: user.username, nonce })),
      ...(refresh ? { refresh_token: refresh } : {}),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
    };
  };

  const authenticateClient = (authorization: string | undefined, body: Params): Client | null => {
    const basic = basicCredentials(authorization);
    const client = findClient(basic?.id ?? body['client_id']);
    if (!client) return null;
    if (client.secret === null) return client;
    const secret = basic?.secret ?? body['client_secret'];
    return secret !== undefined && safeEqual(secret, client.secret) ? client : null;
  };

  app.post('/oauth2/token', async (req, reply) => {
    const body = (req.body ?? {}) as Params;
    reply.header('cache-control', 'no-store');
    const client = authenticateClient(req.headers.authorization, body);
    if (!client) return oauthError(reply, 401, 'invalid_client');

    switch (body['grant_type']) {
      case 'client_credentials': {
        if (client.secret === null) return oauthError(reply, 400, 'unauthorized_client');
        const requested = body['scope'] ? body['scope'].split(' ').filter(Boolean) : client.allowedScopes;
        // Cognito rejects the whole request rather than silently dropping scopes.
        if (!requested.every((s) => client.allowedScopes.includes(s)))
          return oauthError(reply, 400, 'invalid_scope');
        const claims = accessTokenClaims({
          issuer: config.issuer,
          clientId: client.clientId,
          scope: requested.join(' '),
          nowSeconds: nowSeconds(),
          ttlSeconds: ACCESS_TTL_SECONDS,
        });
        return { access_token: sign(claims), token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS };
      }
      case 'authorization_code': {
        const code = body['code'] ?? '';
        const entry = codes.get(code);
        // Codes are single use, even when the exchange fails.
        codes.delete(code);
        if (!entry || entry.expiresAt < nowSeconds() || entry.clientId !== client.clientId) {
          return oauthError(reply, 400, 'invalid_grant');
        }
        if (body['redirect_uri'] !== entry.redirectUri) {
          return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch');
        }
        if (!body['code_verifier'] || !safeEqual(sha256b64url(body['code_verifier']), entry.challenge)) {
          return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
        }
        const refresh = randomBytes(32).toString('base64url');
        refreshGrants.set(refresh, {
          clientId: client.clientId,
          user: entry.user,
          scope: entry.scope,
          expiresAt: nowSeconds() + REFRESH_TTL_SECONDS,
        });
        return userTokens(client, entry.user, entry.scope, entry.nonce, refresh);
      }
      case 'refresh_token': {
        const grant = refreshGrants.get(body['refresh_token'] ?? '');
        if (!grant || grant.expiresAt < nowSeconds() || grant.clientId !== client.clientId) {
          return oauthError(reply, 400, 'invalid_grant');
        }
        return userTokens(client, grant.user, grant.scope, null, null);
      }
      default:
        return oauthError(reply, 400, 'unsupported_grant_type');
    }
  });

  if (config.testHooks) {
    app.get('/test/tokens', async (req, reply) => {
      const q = req.query as Params;
      const variant = q['variant'] ?? 'valid';
      const user = SEED_USERS.find((u) => u.key === (q['user'] ?? 'A'));
      const client = findClient(q['client_id'] ?? 'spa');
      if (!user || !client) return oauthError(reply, 400, 'invalid_request', 'unknown user or client_id');
      const isUserClient = client.secret === null;
      const base = {
        issuer: variant === 'wrong_issuer' ? OTHER_POOL_ISSUER : config.issuer,
        clientId: client.clientId,
        scope: q['scope'] ?? (isUserClient ? USER_SCOPE : client.allowedScopes.join(' ')),
        nowSeconds: variant === 'expired' ? nowSeconds() - 2 * ACCESS_TTL_SECONDS : nowSeconds(),
        ttlSeconds: ACCESS_TTL_SECONDS,
      };
      const claims =
        variant === 'id'
          ? idTokenClaims({ ...base, sub: user.sub, username: user.username, nonce: null })
          : accessTokenClaims({
              ...base,
              ...(isUserClient ? { sub: user.sub, username: user.username } : {}),
            });
      const key = variant === 'bad_signature' ? generateKey() : config.privateKey;
      return { access_token: signJwt(key, claims) };
    });
  }

  return app;
};
