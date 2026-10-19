import { createGuardedServers, registerPublicRoutes, registerServiceRoutes, type AuthClient } from '@cd/auth-client';
import type { Servers } from '@cd/shared';
import type { FastifyBaseLogger } from 'fastify';
import { publicRoutes } from './routes/public.ts';
import { serviceRoutes } from './routes/service.ts';
import type { UseCases } from './routes/use-cases.ts';

export type BuildServersDeps = {
  readonly authClient: AuthClient;
  readonly useCases: UseCases;
  readonly ready: () => Promise<boolean>;
  readonly logger?: FastifyBaseLogger;
  readonly ports?: { readonly public: number; readonly service: number };
};

export const buildServers = (deps: BuildServersDeps): Servers =>
  createGuardedServers({
    ready: deps.ready,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.ports === undefined ? {} : { ports: deps.ports }),
    public: (app) => {
      registerPublicRoutes(app, deps.authClient, publicRoutes(deps.useCases));
    },
    service: (app) => {
      registerServiceRoutes(app, deps.authClient, serviceRoutes(deps.useCases));
    },
  });
