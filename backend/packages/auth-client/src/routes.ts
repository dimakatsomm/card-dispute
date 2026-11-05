import { createServers, type Servers, type ServersOptions } from '@cd/shared';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type { AuthClient } from './auth-client.ts';
import { requireAgent, requireService, requireUser, type GuardHook, type GuardKind } from './guards.ts';

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

export const registerAgentRoutes = (
  app: FastifyInstance,
  authClient: AuthClient,
  routes: readonly RouteOptions[],
): void => {
  const guard = requireAgent(authClient);
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
const UNGUARDED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export type PublicGuardKind = Exclude<GuardKind, 'service'>;

export type GuardedServersOptions = ServersOptions & { readonly publicGuards?: readonly PublicGuardKind[] };

const guardKindsOf = (route: RouteOptions): ReadonlySet<GuardKind | undefined> =>
  new Set([route.onRequest ?? []].flat().map((hook) => (hook as Partial<GuardHook>).guardKind));

const isAgentPath = (url: string): boolean => url === '/agent' || url.startsWith('/agent/');

const isProbe = (route: RouteOptions): boolean =>
  UNGUARDED_PATHS.has(route.url) && [route.method].flat().every((method) => UNGUARDED_METHODS.has(method.toUpperCase()));

// A leading :param or * segment would also match /agent/..., letting a user guard shadow agent routes.
const hasDynamicFirstSegment = (url: string): boolean => /^\/?[:*]/.test(url);

const backstopViolation = (route: RouteOptions, allowed: readonly GuardKind[]): string | undefined => {
  if (isProbe(route)) return undefined;
  if (allowed.includes('agent') && hasDynamicFirstSegment(route.url))
    return 'first path segment is a parameter or wildcard on a server opted in to agents';
  const kinds = guardKindsOf(route);
  if (kinds.has('agent') && !allowed.includes('agent')) return 'agent guard on a server that did not opt in to agents';
  if (kinds.has('agent') && !isAgentPath(route.url)) return 'agent guard outside /agent/*';
  if (isAgentPath(route.url) && !kinds.has('agent')) return '/agent/* route without the agent guard';
  if (!allowed.some((kind) => kinds.has(kind))) return `unguarded: register it through a ${allowed.join('/')} route helper`;
  return undefined;
};

export const guardAllRoutes = (app: FastifyInstance, allowed: readonly GuardKind[]): void => {
  app.addHook('onRoute', (route) => {
    const violation = backstopViolation(route, allowed);
    if (violation) throw new Error(`${route.method.toString()} ${route.url}: ${violation}`);
  });
};

export const createGuardedServers = ({ publicGuards = ['user'], ...options }: GuardedServersOptions): Servers =>
  createServers({
    ...options,
    public: (app) => {
      guardAllRoutes(app, publicGuards);
      return options.public(app);
    },
    service: (app) => {
      guardAllRoutes(app, ['service']);
      return options.service(app);
    },
  });
