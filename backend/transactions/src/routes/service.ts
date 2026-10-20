import type { ServiceRoute } from '@cd/auth-client';
import type { zLookupTransactionsResponse } from '@cd/contracts/transactions.service';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { z } from 'zod';
import type { LookupQuery, Transaction } from '../core/transaction.ts';
import { lookupQuerySchema } from './query.ts';

type LookupResponse = z.infer<typeof zLookupTransactionsResponse>;

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
      if (!result.ok) return assertNever(result.error);
      const body: LookupResponse = { items: [...result.value] };
      return body;
    },
  },
];
