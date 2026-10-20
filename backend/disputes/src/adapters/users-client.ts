import { zListCardsForUserResponse } from '@cd/contracts/users.service';
import { ok } from '@cd/shared/fp';
import type { Card } from '../core/types.ts';
import type { FindCard } from '../use-cases/ports.ts';
import { getJson, type ServiceClientDeps } from './service-client.ts';

export const createUsersClient = (deps: ServiceClientDeps): { readonly findCard: FindCard } => {
  const get = getJson(deps);
  return {
    findCard: async (userId, cardId, correlationId) => {
      const res = await get('/cards', { userId, cardId }, zListCardsForUserResponse, correlationId);
      if (!res.ok) return res;
      const match: Card | undefined = res.value.cards.find((c) => c.cardId === cardId && c.userId === userId);
      return ok(match ?? null);
    },
  };
};
