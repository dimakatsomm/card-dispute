import { createGuardedServers, registerPublicRoutes, registerServiceRoutes, type AuthClient } from '@cd/auth-client';
import type { Servers } from '@cd/shared';
import type { FastifyBaseLogger } from 'fastify';
import { publicRoutes, type PublicUseCases } from './routes/public.ts';
import { serviceRoutes, type ServiceUseCases } from './routes/service.ts';

export type AppDeps = PublicUseCases &
  ServiceUseCases & {
    readonly authClient: AuthClient;
    readonly logger: FastifyBaseLogger;
    readonly ready: () => Promise<boolean>;
    readonly ports?: { readonly public: number; readonly service: number };
  };

export const createApp = (deps: AppDeps): Servers =>
  createGuardedServers({
    logger: deps.logger,
    ready: deps.ready,
    ...(deps.ports === undefined ? {} : { ports: deps.ports }),
    public: (app) => {
      registerPublicRoutes(app, deps.authClient, publicRoutes(deps));
    },
    service: (app) => {
      registerServiceRoutes(app, deps.authClient, serviceRoutes(deps));
    },
  });
