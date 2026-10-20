import { userPrincipalOf } from '@cd/auth-client';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import type { Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import { listTransactionsProblem } from '../errors.ts';
import type {
  ListTransactionsError,
  ListTransactionsInput,
  ListTransactionsOutput,
} from '../use-cases/list-transactions.ts';
import { listQuerySchema } from './query.ts';

export type PublicUseCases = {
  readonly listTransactions: (
    input: ListTransactionsInput,
  ) => Promise<Result<ListTransactionsOutput, ListTransactionsError>>;
};

export const publicRoutes = (uc: PublicUseCases): RouteOptions[] => [
  {
    method: 'GET',
    url: '/transactions',
    handler: async (request, reply) => {
      const query = parseRequest(listQuerySchema, request.query);
      if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
      const { cursor, limit, status, ...filter } = query.value;
      const result = await uc.listTransactions({
        userId: userPrincipalOf(request).userId,
        filter: { ...filter, statuses: status },
        cursor,
        limit,
        correlationId: request.id,
      });
      if (!result.ok) return sendProblem(reply, listTransactionsProblem(result.error, request.id));
      if (result.value.degraded.length > 0) {
        request.log.warn({ degraded: result.value.degraded }, 'transaction enrichment unavailable');
      }
      return { items: result.value.items, nextCursor: result.value.nextCursor };
    },
  },
];
