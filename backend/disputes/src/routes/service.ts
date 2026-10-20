import type { ServiceRoute } from '@cd/auth-client';
import { zLookupDisputesQuery, type zLookupDisputesResponse } from '@cd/contracts/disputes.service';
import { queryOf } from '@cd/contracts/query';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { z } from 'zod';
import type { DisputeRef } from '../use-cases/ports.ts';
import type { LookupDisputesInput } from '../use-cases/lookup-disputes.ts';

type LookupResponse = z.output<typeof zLookupDisputesResponse>;

const lookupQuery = queryOf(zLookupDisputesQuery, { csv: ['transactionIds'] });

export type LookupDisputesUseCase = (
  input: LookupDisputesInput,
) => Promise<Result<ReadonlyArray<DisputeRef>, never>>;

export const serviceRoutes = (lookupDisputes: LookupDisputesUseCase): ReadonlyArray<ServiceRoute> => [
  {
    method: 'GET',
    url: '/disputes',
    scope: 'disputes/read',
    handler: async (request, reply) => {
      const query = parseRequest(lookupQuery, request.query);
      if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
      const result = await lookupDisputes(query.value);
      if (!result.ok) return assertNever(result.error);
      const body: LookupResponse = { items: [...result.value] };
      return reply.code(200).send(body);
    },
  },
];
