import { zLookupDisputesResponse } from '@cd/contracts/disputes.service';
import { err, ok } from '@cd/shared/fp';
import type { LookupDisputes } from '../use-cases/ports.ts';
import { getJson, type ServiceClientDeps } from './service-client.ts';

export const createDisputesClient = (deps: ServiceClientDeps): { readonly lookupDisputes: LookupDisputes } => {
  const get = getJson(deps);
  return {
    lookupDisputes: async (userId, transactionId, correlationId) => {
      const query = new URLSearchParams({ userId, transactionIds: transactionId });
      const res = await get(`/disputes?${query.toString()}`, zLookupDisputesResponse, correlationId);
      if (res.ok) return ok(res.value.items);
      // The lookup answers 200 with no items for an unknown dispute, so a 404 is a routing fault, not absence.
      return err({ kind: 'unavailable' });
    },
  };
};
