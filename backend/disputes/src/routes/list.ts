import { userPrincipalOf } from '@cd/auth-client';
import { zListMyDisputesQuery } from '@cd/contracts/disputes.public';
import { queryOf } from '@cd/contracts/query';
import { parseRequest, problemBody, sendProblem, validationProblem, type ProblemBody } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import type { DisputePage } from '../core/types.ts';
import type { ListDisputesError, ListDisputesInput } from '../use-cases/list-disputes.ts';

const listQuery = queryOf(zListMyDisputesQuery);

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
