import type { ServiceRoute } from '@cd/auth-client';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import { z } from 'zod';
import type { DisputeRef } from '../use-cases/ports.ts';
import type { LookupDisputesInput } from '../use-cases/lookup-disputes.ts';

const MAX_IDS = 100;

// guid, not uuid: accept exactly the ids the caller (transactions' own lookup schema) accepts, so it never sees a 400.
const lookupQuery = z.object({
  userId: z.guid(),
  transactionIds: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(z.guid()).min(1).max(MAX_IDS)),
});

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
      return result.ok ? reply.code(200).send({ items: result.value }) : assertNever(result.error);
    },
  },
];
