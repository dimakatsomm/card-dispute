import type { ServiceRoute } from '@cd/auth-client';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { LookupQuery, Transaction } from '../core/transaction.ts';
import { lookupQuerySchema } from './query.ts';

export type ServiceUseCases = {
  readonly lookupTransactions: (query: LookupQuery) => Promise<Result<ReadonlyArray<Transaction>, never>>;
};

export const serviceRoutes = (uc: ServiceUseCases): ServiceRoute[] => [
  {
    method: 'GET',
    url: '/transactions',
    scope: 'transactions/read',
    handler: async (request, reply) => {
      const query = parseRequest(lookupQuerySchema, request.query);
      if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
      const result = await uc.lookupTransactions(query.value);
      return result.ok ? { items: result.value } : assertNever(result.error);
    },
  },
];
