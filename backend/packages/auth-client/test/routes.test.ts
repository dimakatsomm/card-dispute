import { createLogger, type Servers } from '@cd/shared';
import { ok } from '@cd/shared/fp';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthClient } from '../src/auth-client.ts';
import { agentPrincipalOf, requireAgent, servicePrincipalOf, userPrincipalOf } from '../src/guards.ts';
import {
  createGuardedServers,
  guardAllRoutes,
  registerAgentRoutes,
  registerPublicRoutes,
  registerServiceRoutes,
  type GuardedServersOptions,
} from '../src/routes.ts';
import {
  AGENT_ID,
  AGENT_NAME,
  agentPrincipal,
  fakeFetch,
  invalidResult,
  jsonResponse,
  servicePrincipal,
  USER_ID,
  userPrincipal,
} from './fakes.ts';

const NOW = 1_800_000_000_000;
const EXP = Math.floor(NOW / 1000) + 900;

const tokens: Record<string, unknown> = {
  'header.user-token.signature': userPrincipal(EXP),
  'header.service-token-ok.signature': servicePrincipal(EXP, ['users/cards.read']),
  'header.service-token-other-scope.signature': servicePrincipal(EXP, ['transactions/read']),
  'header.revoked-token.signature': invalidResult('disabled'),
  'header.agent-token.signature': agentPrincipal(EXP),
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
    return jsonResponse(200, tokens[token] ?? invalidResult('bad_signature'));
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
    publicGuards: ['user', 'agent'],
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
      registerAgentRoutes(app, authClient, [
        {
          method: 'GET',
          url: '/agent/queue',
          handler: async (request) => {
            handlerRuns.push('/agent/queue');
            return { agentId: agentPrincipalOf(request).agentId, displayName: agentPrincipalOf(request).displayName };
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
    const res = await get(build().servers.public, '/me', 'Bearer header.user-token.signature');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: USER_ID });
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    expect((await get(build().servers.public, '/me', 'bearer header.user-token.signature')).statusCode).toBe(200);
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

  it.each(['not-a-jwt', 'aaaaaaaaaa.bbbbbbbbbbbb', 'a'.repeat(300), `${'a'.repeat(150)}.${'b'.repeat(150)}`, 'aaaaaaaaaa.bbbbbbbbbb.', '..aaaaaaaaaaaaaaaaaaaa', 'aaaaaaaa.bbbbbbbb.ccéc'])(
    'rejects non-JWT bearer %s with 401 without calling auth',
    async (value) => {
      const { servers, stub } = build();
      const res = await get(servers.public, '/me', `Bearer ${value}`);
      expect(res.statusCode).toBe(401);
      expect(stub.calls).toHaveLength(0);
    },
  );

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
    const res = await get(servers.public, '/nope', 'Bearer header.user-token.signature');
    expect(res.statusCode).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects an invalid token with 401 and does not leak the reason', async () => {
    const res = await get(build().servers.public, '/me', 'Bearer header.revoked-token.signature');
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('disabled');
  });

  it('rejects a service principal with 403', async () => {
    const res = await get(build().servers.public, '/me', 'Bearer header.service-token-ok.signature');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects an agent principal with 403', async () => {
    const { servers, handlerRuns } = build();
    const res = await get(servers.public, '/me', 'Bearer header.agent-token.signature');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(handlerRuns).toEqual([]);
  });

  it('answers 503 when auth is unavailable, never letting the request through', async () => {
    const { servers, handlerRuns } = build(true);
    const res = await get(servers.public, '/me', 'Bearer header.user-token.signature');
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE', status: 503 });
    expect(handlerRuns).toEqual([]);
  });
});

describe('agent routes (requireAgent)', () => {
  it('attaches the agent principal for a valid agent token', async () => {
    const res = await get(build().servers.public, '/agent/queue', 'Bearer header.agent-token.signature');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agentId: AGENT_ID, displayName: AGENT_NAME });
  });

  it.each([
    ['user', 'Bearer header.user-token.signature'],
    ['service', 'Bearer header.service-token-ok.signature'],
  ])('rejects a %s principal with 403 and does not run the handler', async (_name, header) => {
    const { servers, handlerRuns } = build();
    const res = await get(servers.public, '/agent/queue', header);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(handlerRuns).toEqual([]);
  });

  it('rejects a missing or invalid token with 401', async () => {
    const { servers } = build();
    expect((await get(servers.public, '/agent/queue')).statusCode).toBe(401);
    expect((await get(servers.public, '/agent/queue', 'Bearer header.revoked-token.signature')).statusCode).toBe(401);
  });
});

describe('service routes (requireService)', () => {
  it('allows a service principal with the route scope', async () => {
    const res = await get(build().servers.service, '/cards', 'Bearer header.service-token-ok.signature');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientId: 'svc-transactions' });
  });

  it('rejects a user principal with 403', async () => {
    expect((await get(build().servers.service, '/cards', 'Bearer header.user-token.signature')).statusCode).toBe(403);
  });

  it('rejects an agent principal with 403', async () => {
    expect((await get(build().servers.service, '/cards', 'Bearer header.agent-token.signature')).statusCode).toBe(403);
  });

  it('rejects a missing scope with 403', async () => {
    expect((await get(build().servers.service, '/cards', 'Bearer header.service-token-other-scope.signature')).statusCode).toBe(403);
  });

  it('rejects a missing token with 401 and answers 503 when auth is unavailable', async () => {
    expect((await get(build().servers.service, '/cards')).statusCode).toBe(401);
    expect((await get(build(true).servers.service, '/cards', 'Bearer header.service-token-ok.signature')).statusCode).toBe(503);
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
    expect((await get(app, '/x', 'Bearer header.revoked-token.signature')).statusCode).toBe(401);
    expect(order).toEqual([]);
    await app.close();
  });
});

describe('unguarded-route backstop', () => {
  it('throws at registration when a route is added directly to the guarded app', () => {
    const app = Fastify();
    guardAllRoutes(app, ['user']);
    expect(() => app.get('/x', async () => ({}))).toThrow(/GET \/x: unguarded/);
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

  const startPublic = async (
    publicGuards: GuardedServersOptions['publicGuards'],
    register: GuardedServersOptions['public'],
  ): Promise<void> => {
    const servers = createGuardedServers({
      logger: createLogger({ level: 'silent' }),
      ...(publicGuards === undefined ? {} : { publicGuards }),
      public: register,
      service: () => undefined,
    });
    open = servers;
    await servers.public.ready();
  };

  it('rejects an agent route on a public server that did not opt in', async () => {
    const { authClient } = build();
    await expect(
      startPublic(undefined, (app) => {
        registerAgentRoutes(app, authClient, [{ method: 'GET', url: '/agent/queue', handler: async () => ({}) }]);
      }),
    ).rejects.toThrow(/did not opt in/);
  });

  it('rejects an agent route on the service port', async () => {
    const { authClient } = build();
    const servers = createGuardedServers({
      logger: createLogger({ level: 'silent' }),
      publicGuards: ['user', 'agent'],
      public: () => undefined,
      service: (app) => {
        registerAgentRoutes(app, authClient, [{ method: 'GET', url: '/agent/queue', handler: async () => ({}) }]);
      },
    });
    open = servers;
    await expect(servers.service.ready()).rejects.toThrow(/did not opt in/);
  });

  it('rejects an agent guard outside /agent/*', async () => {
    const { authClient } = build();
    await expect(
      startPublic(['user', 'agent'], (app) => {
        registerAgentRoutes(app, authClient, [{ method: 'GET', url: '/agents-queue', handler: async () => ({}) }]);
      }),
    ).rejects.toThrow(/agent guard outside \/agent/);
  });

  it.each([
    ['user-guarded', 'user'],
    ['unguarded', 'none'],
  ] as const)('rejects an %s route under /agent/* on an opted-in server', async (_name, guard) => {
    const { authClient } = build();
    await expect(
      startPublic(['user', 'agent'], (app) => {
        const route = { method: 'GET', url: '/agent/disputes', handler: async () => ({}) } as const;
        if (guard === 'user') registerPublicRoutes(app, authClient, [route]);
        else app.route(route);
      }),
    ).rejects.toThrow(/\/agent\/\* route without the agent guard/);
  });

  it('rejects an unguarded public route on an opted-in server', async () => {
    await expect(
      startPublic(['user', 'agent'], (app) => {
        app.get('/x', async () => ({}));
      }),
    ).rejects.toThrow(/GET \/x: unguarded/);
  });

  it('accepts a hand-attached agent guard on an /agent/* route of an opted-in server', async () => {
    const { authClient } = build();
    await expect(
      startPublic(['user', 'agent'], (app) => {
        app.get('/agent', { onRequest: requireAgent(authClient) }, async () => ({}));
      }),
    ).resolves.toBeUndefined();
  });

  it('still serves health and ready without a guard', async () => {
    const { servers } = build();
    expect((await get(servers.public, '/health')).statusCode).toBe(200);
    expect((await get(servers.service, '/ready')).statusCode).toBe(200);
  });
});
