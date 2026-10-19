import { createLogger, type Servers } from '@cd/shared';
import { ok } from '@cd/shared/fp';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthClient } from '../src/auth-client.ts';
import { servicePrincipalOf, userPrincipalOf } from '../src/guards.ts';
import { createGuardedServers, guardAllRoutes, registerPublicRoutes, registerServiceRoutes } from '../src/routes.ts';
import { fakeFetch, jsonResponse, servicePrincipal, userPrincipal } from './fakes.ts';

const NOW = 1_800_000_000_000;
const EXP = Math.floor(NOW / 1000) + 900;

const tokens: Record<string, unknown> = {
  'user-token': userPrincipal(EXP),
  'service-token-ok': servicePrincipal(EXP, ['users/cards.read']),
  'service-token-other-scope': servicePrincipal(EXP, ['transactions/read']),
  'revoked-token': { valid: false, reason: 'disabled' },
};

let open: Servers | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const build = (authDown = false) => {
  const stub = fakeFetch((call) => {
    if (authDown) return jsonResponse(503, {});
    const { token } = JSON.parse(call.body ?? '{}') as { token: string };
    return jsonResponse(200, tokens[token] ?? { valid: false, reason: 'bad_signature' });
  });
  const authClient = createAuthClient({
    authUrl: 'http://auth',
    fetch: stub.fetch,
    now: () => NOW,
    getServiceToken: async () => ok('own-service-token'),
  });
  const handlerRuns: string[] = [];
  const servers = createGuardedServers({
    logger: createLogger({ level: 'silent' }),
    public: (app) => {
      registerPublicRoutes(app, authClient, [
        {
          method: 'GET',
          url: '/me',
          handler: async (request) => {
            handlerRuns.push('/me');
            return { userId: userPrincipalOf(request).userId };
          },
        },
      ]);
    },
    service: (app) => {
      registerServiceRoutes(app, authClient, [
        {
          method: 'GET',
          url: '/cards',
          scope: 'users/cards.read',
          handler: async (request) => ({ clientId: servicePrincipalOf(request).clientId }),
        },
      ]);
    },
  });
  open = servers;
  return { servers, stub, handlerRuns, authClient };
};

const get = (app: Servers['public'], url: string, authorization?: string, method: 'GET' | 'HEAD' = 'GET') =>
  app.inject({ method, url, ...(authorization === undefined ? {} : { headers: { authorization } }) });

describe('public routes (requireUser)', () => {
  it('attaches the user principal for a valid user token', async () => {
    const res = await get(build().servers.public, '/me', 'Bearer user-token');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'user-1' });
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    expect((await get(build().servers.public, '/me', 'bearer user-token')).statusCode).toBe(200);
  });

  it.each([
    ['missing header', undefined],
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['empty token', 'Bearer '],
    ['token with spaces', 'Bearer a b'],
  ])('rejects %s with 401 problem+json', async (_name, header) => {
    const res = await get(build().servers.public, '/me', header);
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('rejects an oversized token with 401 without calling auth', async () => {
    const { servers, stub } = build();
    const res = await get(servers.public, '/me', `Bearer ${'a'.repeat(4097)}`);
    expect(res.statusCode).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects HEAD without a token and does not run the handler', async () => {
    const { servers, handlerRuns } = build();
    const res = await get(servers.public, '/me', undefined, 'HEAD');
    expect(res.statusCode).toBe(401);
    expect(handlerRuns).toEqual([]);
  });

  it('answers 404 for an unknown path without calling auth', async () => {
    const { servers, stub } = build();
    const res = await get(servers.public, '/nope', 'Bearer user-token');
    expect(res.statusCode).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects an invalid token with 401 and does not leak the reason', async () => {
    const res = await get(build().servers.public, '/me', 'Bearer revoked-token');
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('disabled');
  });

  it('rejects a service principal with 403', async () => {
    const res = await get(build().servers.public, '/me', 'Bearer service-token-ok');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('answers 503 when auth is unavailable, never letting the request through', async () => {
    const { servers, handlerRuns } = build(true);
    const res = await get(servers.public, '/me', 'Bearer user-token');
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE', status: 503 });
    expect(handlerRuns).toEqual([]);
  });
});

describe('service routes (requireService)', () => {
  it('allows a service principal with the route scope', async () => {
    const res = await get(build().servers.service, '/cards', 'Bearer service-token-ok');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientId: 'svc-transactions' });
  });

  it('rejects a user principal with 403', async () => {
    expect((await get(build().servers.service, '/cards', 'Bearer user-token')).statusCode).toBe(403);
  });

  it('rejects a missing scope with 403', async () => {
    expect((await get(build().servers.service, '/cards', 'Bearer service-token-other-scope')).statusCode).toBe(403);
  });

  it('rejects a missing token with 401 and answers 503 when auth is unavailable', async () => {
    expect((await get(build().servers.service, '/cards')).statusCode).toBe(401);
    expect((await get(build(true).servers.service, '/cards', 'Bearer service-token-ok')).statusCode).toBe(503);
  });

  it('keeps the guard in front of a route-level onRequest hook', async () => {
    const order: string[] = [];
    const { authClient } = build();
    const app = Fastify();
    registerPublicRoutes(app, authClient, [
      {
        method: 'GET',
        url: '/x',
        onRequest: async () => {
          order.push('route-hook');
        },
        handler: async () => ({}),
      },
    ]);
    expect((await get(app, '/x', 'Bearer revoked-token')).statusCode).toBe(401);
    expect(order).toEqual([]);
    await app.close();
  });
});

describe('unguarded-route backstop', () => {
  it('throws at registration when a route is added directly to the guarded app', () => {
    const app = Fastify();
    guardAllRoutes(app, 'user');
    expect(() => app.get('/x', async () => ({}))).toThrow(/unguarded GET \/x/);
  });

  it('fails startup of a guarded server that registers a route directly', async () => {
    const servers = createGuardedServers({
      logger: createLogger({ level: 'silent' }),
      public: (app) => {
        app.get('/x', async () => ({}));
      },
      service: () => undefined,
    });
    open = servers;
    await expect(servers.public.ready()).rejects.toThrow(/unguarded/);
  });

  it('rejects a service-guarded route on the public instance', async () => {
    const { authClient } = build();
    const servers = createGuardedServers({
      logger: createLogger({ level: 'silent' }),
      public: (app) => {
        registerServiceRoutes(app, authClient, [{ method: 'GET', url: '/y', scope: 's', handler: async () => ({}) }]);
      },
      service: () => undefined,
    });
    open = servers;
    await expect(servers.public.ready()).rejects.toThrow(/unguarded/);
  });

  it('still serves health and ready without a guard', async () => {
    const { servers } = build();
    expect((await get(servers.public, '/health')).statusCode).toBe(200);
    expect((await get(servers.service, '/ready')).statusCode).toBe(200);
  });
});
