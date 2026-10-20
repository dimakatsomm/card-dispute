import { userPrincipalOf } from '@cd/auth-client';
import { DISPUTE_STATUSES } from '@cd/dispute-domain';
import { parseRequest, problemBody, sendProblem, validationProblem, type ProblemBody } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import { z } from 'zod';
import type { DisputePage, ListDisputesError, ListDisputesInput } from '../use-cases/list-disputes.ts';

const asArray = (value: unknown): unknown => (typeof value === 'string' ? [value] : value);

const listQuery = z.object({
  status: z
    .preprocess(asArray, z.array(z.enum(DISPUTE_STATUSES)).min(1).max(DISPUTE_STATUSES.length))
    .optional(),
  accountId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
});

export type ListDisputesUseCase = (
  input: ListDisputesInput,
) => Promise<Result<DisputePage, ListDisputesError>>;

const listDisputesProblem = (error: ListDisputesError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'INVALID_CURSOR':
      return problemBody({
        status: 400,
        title: 'Validation Failed',
        code: 'INVALID_CURSOR',
        detail: 'cursor: not a cursor issued by this API',
        correlationId,
      });
    case 'UPSTREAM_UNAVAILABLE':
      return problemBody({
        status: 503,
        title: 'Service Unavailable',
        code: 'UPSTREAM_UNAVAILABLE',
        detail: 'The account or card filter cannot be answered right now',
        correlationId,
      });
    default:
      return assertNever(error);
  }
};

export const listDisputesRoute = (listDisputes: ListDisputesUseCase): RouteOptions => ({
  method: 'GET',
  url: '/disputes',
  handler: async (request, reply) => {
    const query = parseRequest(listQuery, request.query);
    if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
    const { status, accountId, cardId, limit, cursor } = query.value;

    const result = await listDisputes({
      userId: userPrincipalOf(request).userId,
      statuses: status ?? [],
      filter: {
        ...(accountId === undefined ? {} : { accountId }),
        ...(cardId === undefined ? {} : { cardId }),
      },
      limit,
      cursor,
      correlationId: request.id,
    });
    if (!result.ok) return sendProblem(reply, listDisputesProblem(result.error, request.id));
    return reply.code(200).send(result.value);
  },
});
