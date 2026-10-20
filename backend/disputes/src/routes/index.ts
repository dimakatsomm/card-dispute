import { registerPublicRoutes, registerServiceRoutes, type AuthClient } from '@cd/auth-client';
import type { FastifyInstance } from 'fastify';
import { createDisputeRoute, type CreateDisputeUseCase } from './create.ts';
import { getDisputeRoute } from './get.ts';
import { listDisputesRoute } from './list.ts';
import { serviceRoutes } from './service.ts';
import { updateDisputeRoute } from './update.ts';

export type UseCases = { readonly createDispute: CreateDisputeUseCase };

export const registerPublic =
  (authClient: AuthClient, useCases: UseCases) =>
  (app: FastifyInstance): void => {
    registerPublicRoutes(app, authClient, [
      createDisputeRoute(useCases.createDispute),
      updateDisputeRoute(),
      getDisputeRoute(),
      listDisputesRoute(),
    ]);
  };

export const registerService =
  (authClient: AuthClient) =>
  (app: FastifyInstance): void => {
    registerServiceRoutes(app, authClient, serviceRoutes());
  };
