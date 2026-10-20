import { CARD_STATUSES } from '@cd/dispute-domain';
import { ok } from '@cd/shared/fp';
import { z } from 'zod';
import type { Card } from '../core/types.ts';
import type { FindCard } from '../use-cases/ports.ts';
import { getJson, type ServiceClientDeps } from './service-client.ts';

const card = z.object({
  cardId: z.uuid(),
  userId: z.uuid(),
  expiryMonth: z.number().int(),
  expiryYear: z.number().int(),
  status: z.enum(CARD_STATUSES),
});

const cardsResponse = z.object({ cards: z.array(card) });

export const createUsersClient = (deps: ServiceClientDeps): { readonly findCard: FindCard } => {
  const get = getJson(deps);
  return {
    findCard: async (userId, cardId, correlationId) => {
      const res = await get('/cards', { userId, cardId }, cardsResponse, correlationId);
      if (!res.ok) return res;
      const match: Card | undefined = res.value.cards.find((c) => c.cardId === cardId && c.userId === userId);
      return ok(match ?? null);
    },
  };
};
