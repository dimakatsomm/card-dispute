import { createServers, type Servers, type ServersOptions } from '@cd/shared';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type { AuthClient } from './auth-client.ts';
import { requireService, requireUser, type GuardHook, type GuardKind } from './guards.ts';

export type ServiceRoute = RouteOptions & { readonly scope: string };

const withGuard = (route: RouteOptions, guard: GuardHook): RouteOptions => ({
  ...route,
  onRequest: [guard, ...(route.onRequest === undefined ? [] : [route.onRequest].flat())],
});

const registerGuarded = (app: FastifyInstance, routes: readonly RouteOptions[]): void => {
  void app.register(async (instance) => {
    for (const route of routes) instance.route(route);
  });
};

export const registerPublicRoutes = (
  app: FastifyInstance,
  authClient: AuthClient,
  routes: readonly RouteOptions[],
): void => {
  const guard = requireUser(authClient);
  registerGuarded(
    app,
    routes.map((route) => withGuard(route, guard)),
  );
};

export const registerServiceRoutes = (
  app: FastifyInstance,
  authClient: AuthClient,
  routes: readonly ServiceRoute[],
): void => {
  registerGuarded(
    app,
    routes.map(({ scope, ...route }) => withGuard(route, requireService(authClient, scope))),
  );
};

const UNGUARDED_PATHS: ReadonlySet<string> = new Set(['/health', '/ready']);

const hasGuard = (route: RouteOptions, kind: GuardKind): boolean =>
  [route.onRequest ?? []].flat().some((hook) => (hook as Partial<GuardHook>).guardKind === kind);

export const guardAllRoutes = (app: FastifyInstance, kind: GuardKind): void => {
  app.addHook('onRoute', (route) => {
    if (UNGUARDED_PATHS.has(route.url) || hasGuard(route, kind)) return;
    throw new Error(`unguarded ${route.method.toString()} ${route.url}: register it through the ${kind} route helper`);
  });
};

export const createGuardedServers = (options: ServersOptions): Servers =>
  createServers({
    ...options,
    public: (app) => {
      guardAllRoutes(app, 'user');
      return options.public(app);
    },
    service: (app) => {
      guardAllRoutes(app, 'service');
      return options.service(app);
    },
  });
