import type { ServiceRoute } from '@cd/auth-client';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import { z } from 'zod';
import { toProblem } from '../errors.ts';
import type { UseCases } from './use-cases.ts';

export const SCOPES = Object.freeze({
  cardsRead: 'users/cards.read',
  contactRead: 'users/contact.read',
} as const);

const cardsQuery = z.object({
  userId: z.guid(),
  accountId: z.guid().optional(),
  cardId: z.guid().optional(),
});

const contactParams = z.object({ userId: z.guid() });

export const serviceRoutes = (uc: UseCases): readonly ServiceRoute[] => [
  {
    method: 'GET',
    url: '/cards',
    scope: SCOPES.cardsRead,
    handler: async (request, reply) => {
      const query = parseRequest(cardsQuery, request.query);
      if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
      const result = await uc.listCards(query.value);
      return result.ok ? { cards: result.value } : sendProblem(reply, toProblem(result.error, request.id));
    },
  },
  {
    method: 'GET',
    url: '/users/:userId/contact',
    scope: SCOPES.contactRead,
    handler: async (request, reply) => {
      const params = parseRequest(contactParams, request.params);
      // Not a uuid cannot name a user: same answer as unknown, so ids are not probeable by shape.
      if (!params.ok) return sendProblem(reply, toProblem('NOT_FOUND', request.id));
      const result = await uc.getContact(params.value.userId);
      return result.ok ? result.value : sendProblem(reply, toProblem(result.error, request.id));
    },
  },
];
