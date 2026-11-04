import { zValidateTokenResponse } from '@cd/contracts/auth.service';
import { createLogger, type Servers } from '@cd/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServers, type AuthConfig } from '../../src/main.ts';
import { startAuthDb, type AuthDb } from '../support/db.ts';
import {
  AGENT_CLIENTS,
  agentClaims,
  hs256WithPublicKey,
  ISSUER,
  newKey,
  SERVICE_CLIENTS,
  serviceClaims,
  signJwt,
  startJwksServer,
  USER_CLIENTS,
  userClaims,
  type JwksServer,
  unsignedJwt,
  type TestKey,
} from '../support/issuer.ts';

const ACTIVE = {
  sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  username: 'thandi.nkosi',
  userId: '01990000-0000-7000-8000-00000000000a',
};
const DISABLED = {
  sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  username: 'dumisani.zulu',
  userId: '01990000-0000-7000-8000-00000000000d',
};
const UNKNOWN_SUB = '99999999-9999-4999-8999-999999999999';
const AGENT = { sub: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', displayName: 'Naledi M.' };
const DISABLED_AGENT = { sub: 'ffffffff-ffff-4fff-8fff-ffffffffffff', displayName: 'Pieter V.' };
const AGENT_WITHOUT_ROW = '77777777-7777-4777-8777-777777777777';
const BOTH_ROLES = {
  sub: '88888888-8888-4888-8888-888888888888',
  username: 'both.roles',
  userId: '01990000-0000-7000-8000-000000000088',
  displayName: 'Both R.',
};

const silentLogger = createLogger({ level: 'silent' });

let db: AuthDb;
let jwks: JwksServer;
const key: TestKey = newKey('test-key-1');
let servers: Servers;
let activeAuthId: string;
let agentId: string;
const fetchedUrls: string[] = [];

const configFor = (jwksUri: string): AuthConfig => ({
  issuer: ISSUER,
  jwksUri,
  clients: { user: USER_CLIENTS, service: SERVICE_CLIENTS, agent: AGENT_CLIENTS },
  allowInsecureJwks: true,
});

const recordingFetch: typeof fetch = (input, init) => {
  fetchedUrls.push(String(input));
  return fetch(input, init);
};

const callerToken = (): string =>
  signJwt(key, serviceClaims('svc-transactions', 'auth/validate users/cards.read'));

const postValidate = (
  app: Servers['service'],
  body: unknown,
  authorization: string | null = `Bearer ${callerToken()}`,
) =>
  app.inject({
    method: 'POST',
    url: '/validate',
    headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) },
    payload: JSON.stringify(body),
  });

const expectContract = (body: unknown): void => {
  expect(zValidateTokenResponse.safeParse(body).error).toBeUndefined();
};

beforeAll(async () => {
  [db, jwks] = await Promise.all([startAuthDb(), startJwksServer([key])]);
  activeAuthId = await db.seedIdentity({ ...ACTIVE, status: 'ACTIVE' });
  await db.seedIdentity({ ...DISABLED, status: 'DISABLED' });
  agentId = await db.seedAgent({ ...AGENT, status: 'ACTIVE' });
  await db.seedAgent({ ...DISABLED_AGENT, status: 'DISABLED' });
  await db.seedIdentity({ ...BOTH_ROLES, status: 'ACTIVE' });
  await db.seedAgent({ ...BOTH_ROLES, status: 'ACTIVE' });
  servers = buildServers(configFor(jwks.url), {
    pool: db.appPool,
    fetch: recordingFetch,
    logger: silentLogger,
  });
  await Promise.all([servers.public.ready(), servers.service.ready()]);
});

afterAll(async () => {
  await servers?.close();
  await jwks?.close();
  await db?.stop();
});

describe('caller authentication on POST /validate', () => {
  it('rejects an unauthenticated call with 401 before looking at the body', async () => {
    const res = await postValidate(servers.service, { nonsense: true }, null);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each<[string, () => string, number]>([
    ['a garbage bearer', () => 'Bearer not-a-jwt', 401],
    [
      'an expired service token',
      () => `Bearer ${signJwt(key, serviceClaims('svc-disputes', 'auth/validate', { exp: 1_000 }))}`,
      401,
    ],
    [
      'a service token from a client not on the allow-list',
      () => `Bearer ${signJwt(key, serviceClaims('svc-rogue', 'auth/validate'))}`,
      401,
    ],
    [
      'a user token as caller',
      () => `Bearer ${signJwt(key, userClaims(ACTIVE.sub, { scope: 'auth/validate' }))}`,
      403,
    ],
    [
      'an agent token as caller',
      () => `Bearer ${signJwt(key, agentClaims(AGENT.sub, { scope: 'auth/validate' }))}`,
      403,
    ],
    [
      'a service token without auth/validate',
      () => `Bearer ${signJwt(key, serviceClaims('svc-notifier', 'users/contact.read'))}`,
      403,
    ],
  ])('answers %s with %i', async (_name, authorization, status) => {
    const res = await postValidate(servers.service, { token: callerToken() }, authorization());
    expect(res.statusCode).toBe(status);
  });
});

describe('POST /validate results', () => {
  it('returns the user principal with userId from auth_identity for a known ACTIVE sub, calling only the JWKS', async () => {
    fetchedUrls.length = 0;
    const claims = userClaims(ACTIVE.sub);
    const res = await postValidate(servers.service, { token: signJwt(key, claims) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: true,
      principalType: 'user',
      authId: activeAuthId,
      userId: ACTIVE.userId,
      scopes: ['openid', 'profile', 'email'],
      exp: claims.exp,
    });
    expectContract(res.json());
    expect(fetchedUrls.every((u) => u === jwks.url)).toBe(true);
  });

  it('returns the service principal with its scopes for a client_credentials token', async () => {
    const claims = serviceClaims('svc-disputes', 'users/cards.read transactions/read');
    const res = await postValidate(servers.service, { token: signJwt(key, claims) });
    expect(res.json()).toEqual({
      valid: true,
      principalType: 'service',
      clientId: 'svc-disputes',
      scopes: ['users/cards.read', 'transactions/read'],
      exp: claims.exp,
    });
    expectContract(res.json());
  });

  const otherKey = newKey('test-key-1');
  const strangerKey = newKey('unknown-kid');

  it.each<[string, () => string, string]>([
    [
      'expired',
      () => signJwt(key, userClaims(ACTIVE.sub, { exp: Math.floor(Date.now() / 1000) - 5 })),
      'expired',
    ],
    [
      'signed by another key under a trusted kid',
      () => signJwt(otherKey, userClaims(ACTIVE.sub)),
      'bad_signature',
    ],
    [
      'signed with a kid missing from the JWKS',
      () => signJwt(strangerKey, userClaims(ACTIVE.sub)),
      'bad_signature',
    ],
    [
      'issued by another issuer',
      () =>
        signJwt(key, userClaims(ACTIVE.sub, { iss: 'https://cognito-idp.eu-west-1.amazonaws.com/other' })),
      'wrong_issuer',
    ],
    [
      'from a client not on the allow-list',
      () => signJwt(key, userClaims(ACTIVE.sub, { client_id: 'rogue-spa' })),
      'wrong_client',
    ],
    [
      'an id token',
      () => signJwt(key, { ...userClaims(ACTIVE.sub), token_use: 'id', client_id: undefined, aud: 'spa' }),
      'wrong_token_use',
    ],
    ['for an unknown sub', () => signJwt(key, userClaims(UNKNOWN_SUB)), 'unknown_subject'],
    [
      'alg none',
      () => unsignedJwt({ alg: 'none', typ: 'JWT', kid: key.kid }, userClaims(ACTIVE.sub)),
      'bad_signature',
    ],
    [
      'HS256 keyed with the public key',
      () => hs256WithPublicKey(key, userClaims(ACTIVE.sub)),
      'bad_signature',
    ],
    ['validly signed without exp', () => signJwt(key, userClaims(ACTIVE.sub, { exp: undefined })), 'expired'],
    [
      'not yet valid (future nbf)',
      () => signJwt(key, userClaims(ACTIVE.sub, { nbf: Math.floor(Date.now() / 1000) + 600 })),
      'expired',
    ],
    [
      'an access token without client_id',
      () => signJwt(key, userClaims(ACTIVE.sub, { client_id: undefined })),
      'wrong_client',
    ],
    ['for a DISABLED identity', () => signJwt(key, userClaims(DISABLED.sub)), 'disabled'],
  ])('is invalid when the token is %s', async (_name, token, reason) => {
    const res = await postValidate(servers.service, { token: token() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false, principalType: 'none', reason });
    expectContract(res.json());
  });

  it('treats a token from a service client as a service principal even when it carries a user sub', async () => {
    const claims = userClaims(ACTIVE.sub, { client_id: 'svc-disputes', scope: 'transactions/read' });
    const res = await postValidate(servers.service, { token: signJwt(key, claims) });
    expect(res.json()).toEqual({
      valid: true,
      principalType: 'service',
      clientId: 'svc-disputes',
      scopes: ['transactions/read'],
      exp: claims.exp,
    });
  });

  it('fails with 500, never valid:true, when the identity lookup fails', async () => {
    const deadPool = new pg.Pool({
      connectionString: 'postgres://auth_app:x@127.0.0.1:1/cd',
      connectionTimeoutMillis: 500,
    });
    deadPool.on('error', () => undefined);
    const noDb = buildServers(configFor(jwks.url), { pool: deadPool, fetch, logger: silentLogger });
    try {
      const res = await postValidate(noDb.service, { token: signJwt(key, userClaims(ACTIVE.sub)) });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('"valid":true');
    } finally {
      await noDb.close();
      await deadPool.end();
    }
  });

  it('refuses to start when a client id is on both allow-lists', () => {
    const overlapping = {
      ...configFor(jwks.url),
      clients: { user: ['spa', 'svc-users'], service: ['svc-users'], agent: ['backoffice'] },
    };
    expect(() => buildServers(overlapping, { pool: db.appPool, fetch, logger: silentLogger })).toThrow(
      /overlapping_client_ids/,
    );
  });

  it('rejects a body outside the generated schema as 400', async () => {
    const res = await postValidate(servers.service, { token: callerToken(), userId: ACTIVE.userId });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('fails closed with 500 when the JWKS cannot be fetched', async () => {
    const broken = buildServers(configFor('http://127.0.0.1:1/.well-known/jwks.json'), {
      pool: db.appPool,
      fetch,
      logger: silentLogger,
    });
    try {
      const res = await postValidate(broken.service, { token: callerToken() });
      expect(res.statusCode).toBe(500);
    } finally {
      await broken.close();
    }
  });
});

describe('POST /validate agent principal (ADR-071)', () => {
  it('returns the agent principal with agentId and no scopes for a backoffice token in group agents with an ACTIVE row', async () => {
    const claims = agentClaims(AGENT.sub);
    const res = await postValidate(servers.service, { token: signJwt(key, claims) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, principalType: 'agent', agentId, scopes: [], exp: claims.exp });
    expectContract(res.json());
  });

  it.each<[string, () => Record<string, unknown>, string]>([
    ['the agent row is DISABLED', () => agentClaims(DISABLED_AGENT.sub), 'disabled'],
    ['the sub has no agent row', () => agentClaims(AGENT_WITHOUT_ROW), 'unknown_subject'],
    ['the sub is only a customer', () => agentClaims(ACTIVE.sub), 'unknown_subject'],
    [
      'the token lacks cognito:groups',
      () => agentClaims(AGENT.sub, { 'cognito:groups': undefined }),
      'unknown_subject',
    ],
    [
      'cognito:groups lacks agents',
      () => agentClaims(AGENT.sub, { 'cognito:groups': ['support'] }),
      'unknown_subject',
    ],
    [
      'cognito:groups is a string',
      () => agentClaims(AGENT.sub, { 'cognito:groups': 'agents' }),
      'unknown_subject',
    ],
    [
      'cognito:groups holds a non-string',
      () => agentClaims(AGENT.sub, { 'cognito:groups': ['agents', 7] }),
      'unknown_subject',
    ],
    ['the sub is both agent and customer', () => agentClaims(BOTH_ROLES.sub), 'ambiguous_role'],
    [
      'an agent signs in on the spa client',
      () => userClaims(AGENT.sub, { 'cognito:groups': ['agents'] }),
      'unknown_subject',
    ],
    [
      'a spa token for a sub that is both agent and customer',
      () => userClaims(BOTH_ROLES.sub, { 'cognito:groups': ['agents'] }),
      'ambiguous_role',
    ],
  ])('is invalid when %s', async (_name, claims, reason) => {
    const res = await postValidate(servers.service, { token: signJwt(key, claims()) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false, principalType: 'none', reason });
    expectContract(res.json());
  });

  it('keeps a spa token carrying group agents a customer, never an agent', async () => {
    const claims = userClaims(ACTIVE.sub, { 'cognito:groups': ['agents'] });
    const res = await postValidate(servers.service, { token: signJwt(key, claims) });
    expect(res.json()).toMatchObject({ valid: true, principalType: 'user', userId: ACTIVE.userId });
  });

  it('keeps a service-client token carrying group agents and an agent sub a service principal', async () => {
    const claims = serviceClaims('svc-disputes', 'transactions/read', {
      sub: AGENT.sub,
      'cognito:groups': ['agents'],
    });
    const res = await postValidate(servers.service, { token: signJwt(key, claims) });
    expect(res.json()).toEqual({
      valid: true,
      principalType: 'service',
      clientId: 'svc-disputes',
      scopes: ['transactions/read'],
      exp: claims.exp,
    });
  });
});

describe('ports and probes', () => {
  it('does not register /validate on the public port', async () => {
    const res = await postValidate(servers.public, { token: callerToken() });
    expect(res.statusCode).toBe(404);
  });

  it('serves /health and reports /ready from the database', async () => {
    const deadPool = new pg.Pool({
      connectionString: 'postgres://auth_app:x@127.0.0.1:1/cd',
      connectionTimeoutMillis: 500,
    });
    deadPool.on('error', () => undefined);
    const noDb = buildServers(configFor(jwks.url), { pool: deadPool, fetch, logger: silentLogger });
    try {
      expect((await servers.public.inject({ url: '/health' })).statusCode).toBe(200);
      expect((await servers.service.inject({ url: '/ready' })).statusCode).toBe(200);
      expect((await noDb.service.inject({ url: '/ready' })).statusCode).toBe(503);
    } finally {
      await noDb.close();
      await deadPool.end();
    }
  });
});
