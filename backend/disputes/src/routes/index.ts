import { registerPublicRoutes, registerServiceRoutes, type AuthClient } from '@cd/auth-client';
import type { FastifyInstance } from 'fastify';
import { createDisputeRoute, type CreateDisputeUseCase } from './create.ts';
import { getDisputeRoute, type GetDisputeUseCase } from './get.ts';
import { listDisputesRoute, type ListDisputesUseCase } from './list.ts';
import { serviceRoutes, type LookupDisputesUseCase } from './service.ts';
import { updateDisputeRoute, type UpdateDisputeUseCase } from './update.ts';

export type UseCases = {
  readonly createDispute: CreateDisputeUseCase;
  readonly updateDispute: UpdateDisputeUseCase;
  readonly getDispute: GetDisputeUseCase;
  readonly listDisputes: ListDisputesUseCase;
  readonly lookupDisputes: LookupDisputesUseCase;
};

export const registerPublic =
  (authClient: AuthClient, useCases: UseCases) =>
  (app: FastifyInstance): void => {
    registerPublicRoutes(app, authClient, [
      createDisputeRoute(useCases.createDispute),
      updateDisputeRoute(useCases.updateDispute),
      getDisputeRoute(useCases.getDispute),
      listDisputesRoute(useCases.listDisputes),
    ]);
  };

export const registerServicePort =
  (authClient: AuthClient, useCases: Pick<UseCases, 'lookupDisputes'>) =>
  (app: FastifyInstance): void => {
    registerServiceRoutes(app, authClient, serviceRoutes(useCases.lookupDisputes));
  };
