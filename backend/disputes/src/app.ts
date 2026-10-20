import { createGuardedServers, type AuthClient } from '@cd/auth-client';
import type { Servers } from '@cd/shared';
import type { FastifyBaseLogger } from 'fastify';
import { registerPublic, registerServicePort, type UseCases } from './routes/index.ts';

export type AppDeps = {
  readonly authClient: AuthClient;
  readonly useCases: UseCases;
  readonly logger: FastifyBaseLogger;
  readonly ready: () => Promise<boolean>;
  readonly ports: { readonly public: number; readonly service: number };
};

export const createApp = (deps: AppDeps): Servers =>
  createGuardedServers({
    public: registerPublic(deps.authClient, deps.useCases),
    service: registerServicePort(deps.authClient, deps.useCases),
    ports: deps.ports,
    logger: deps.logger,
    ready: deps.ready,
  });
