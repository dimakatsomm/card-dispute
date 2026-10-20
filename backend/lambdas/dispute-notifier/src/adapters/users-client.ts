import { zGetUserContactResponse } from '@cd/contracts/users.service';
import type { FetchContact } from '../use-cases/ports.ts';
import { getJson, type ServiceClientDeps } from './service-client.ts';

export const createUsersClient = (deps: ServiceClientDeps): { readonly fetchContact: FetchContact } => {
  const get = getJson(deps);
  return {
    fetchContact: (userId, correlationId) =>
      get(`/users/${encodeURIComponent(userId)}/contact`, zGetUserContactResponse, correlationId),
  };
};
