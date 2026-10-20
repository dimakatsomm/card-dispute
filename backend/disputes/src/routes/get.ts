import { userPrincipalOf } from '@cd/auth-client';
import { zGetDisputePath } from '@cd/contracts/disputes.public';
import { commonProblem, parseRequest, sendProblem, validationProblem } from '@cd/shared';
import type { Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import type { DisputeDetail } from '../core/types.ts';
import type { GetDisputeError, GetDisputeInput } from '../use-cases/get-dispute.ts';

export type GetDisputeUseCase = (input: GetDisputeInput) => Promise<Result<DisputeDetail, GetDisputeError>>;

export const getDisputeRoute = (getDispute: GetDisputeUseCase): RouteOptions => ({
  method: 'GET',
  url: '/dispute/:transactionId',
  handler: async (request, reply) => {
    const path = parseRequest(zGetDisputePath, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));

    const result = await getDispute({
      userId: userPrincipalOf(request).userId,
      transactionId: path.value.transactionId,
      correlationId: request.id,
    });
    if (!result.ok) return sendProblem(reply, commonProblem('NOT_FOUND', 'Dispute not found', request.id));
    return reply.code(200).header('etag', `"${result.value.version}"`).send(result.value);
  },
});
