import { registerPublicRoutes, registerServiceRoutes, type AuthClient } from '@cd/auth-client';
import type { FastifyInstance } from 'fastify';
import { addEvidenceRoute, type AddEvidenceUseCase } from './add-evidence.ts';
import { createDisputeRoute, type CreateDisputeUseCase } from './create.ts';
import { getDisputeRoute, type GetDisputeUseCase } from './get.ts';
import { listDisputesRoute, type ListDisputesUseCase } from './list.ts';
import { serviceRoutes, type ServiceUseCases } from './service.ts';
import { updateDisputeRoute, type UpdateDisputeUseCase } from './update.ts';

export type UseCases = {
  readonly createDispute: CreateDisputeUseCase;
  readonly addEvidence: AddEvidenceUseCase;
  readonly updateDispute: UpdateDisputeUseCase;
  readonly getDispute: GetDisputeUseCase;
  readonly listDisputes: ListDisputesUseCase;
} & ServiceUseCases;

export const registerPublic =
  (authClient: AuthClient, useCases: UseCases) =>
  (app: FastifyInstance): void => {
    registerPublicRoutes(app, authClient, [
      createDisputeRoute(useCases.createDispute),
      addEvidenceRoute(useCases.addEvidence),
      updateDisputeRoute(useCases.updateDispute),
      getDisputeRoute(useCases.getDispute),
      listDisputesRoute(useCases.listDisputes),
    ]);
  };

export const registerServicePort =
  (authClient: AuthClient, useCases: ServiceUseCases) =>
  (app: FastifyInstance): void => {
    registerServiceRoutes(app, authClient, serviceRoutes(useCases));
  };
