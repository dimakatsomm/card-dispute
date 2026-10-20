import type { ServiceRoute } from '@cd/auth-client';
import { queryOf } from '@cd/contracts/query';
import {
  zGetUserContactPath,
  zListCardsForUserQuery,
  type zGetUserContactResponse,
  type zListCardsForUserResponse,
} from '@cd/contracts/users.service';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import type { z } from 'zod';
import { toProblem } from '../errors.ts';
import type { UseCases } from './use-cases.ts';

export const SCOPES = Object.freeze({
  cardsRead: 'users/cards.read',
  contactRead: 'users/contact.read',
} as const);

type CardsResponse = z.output<typeof zListCardsForUserResponse>;
type ContactResponse = z.output<typeof zGetUserContactResponse>;

const cardsQuery = queryOf(zListCardsForUserQuery);

export const serviceRoutes = (uc: UseCases): readonly ServiceRoute[] => [
  {
    method: 'GET',
    url: '/cards',
    scope: SCOPES.cardsRead,
    handler: async (request, reply) => {
      const query = parseRequest(cardsQuery, request.query);
      if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
      const result = await uc.listCards(query.value);
      if (!result.ok) return sendProblem(reply, toProblem(result.error, request.id));
      const body: CardsResponse = { cards: [...result.value] };
      return body;
    },
  },
  {
    method: 'GET',
    url: '/users/:userId/contact',
    scope: SCOPES.contactRead,
    handler: async (request, reply) => {
      const params = parseRequest(zGetUserContactPath, request.params);
      if (!params.ok) return sendProblem(reply, validationProblem(params.error, request.id));
      const result = await uc.getContact(params.value.userId);
      if (!result.ok) return sendProblem(reply, toProblem(result.error, request.id));
      const body: ContactResponse = result.value;
      return body;
    },
  },
];
