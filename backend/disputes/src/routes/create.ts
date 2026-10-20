import { userPrincipalOf } from '@cd/auth-client';
import { zCreateDisputeBody, zCreateDisputePath } from '@cd/contracts/disputes.public';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import type { Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import type { CreatedDispute } from '../core/types.ts';
import { createDisputeProblem } from '../errors.ts';
import type { CreateDisputeError, CreateDisputeInput } from '../use-cases/create-dispute.ts';
import { DISPUTE_BODY_LIMIT_BYTES, disputeBodyProblem } from './validation.ts';

export type CreateDisputeUseCase = (
  input: CreateDisputeInput,
) => Promise<Result<CreatedDispute, CreateDisputeError>>;

export const createDisputeRoute = (createDispute: CreateDisputeUseCase): RouteOptions => ({
  method: 'POST',
  url: '/dispute/:transactionId',
  bodyLimit: DISPUTE_BODY_LIMIT_BYTES,
  handler: async (request, reply) => {
    const path = parseRequest(zCreateDisputePath, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
    const body = parseRequest(zCreateDisputeBody, request.body);
    if (!body.ok) return sendProblem(reply, disputeBodyProblem(body.error, request.id));

    const result = await createDispute({
      userId: userPrincipalOf(request).userId,
      transactionId: path.value.transactionId,
      reasonCode: body.value.reasonCode,
      description: body.value.description,
      evidence: body.value.evidence ?? [],
      correlationId: request.id,
    });
    if (!result.ok) return sendProblem(reply, createDisputeProblem(result.error, request.id));
    return reply
      .code(201)
      .header('etag', `"${result.value.version}"`)
      .header('location', `/dispute/${result.value.transactionId}`)
      .send(result.value);
  },
});
