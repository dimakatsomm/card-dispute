import { userPrincipalOf } from '@cd/auth-client';
import { zAddEvidenceBody, zAddEvidencePath } from '@cd/contracts/disputes.public';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import type { Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import { addEvidenceProblem } from '../errors.ts';
import type { AddedEvidence, AddEvidenceError, AddEvidenceInput } from '../use-cases/add-evidence.ts';
import { DISPUTE_BODY_LIMIT_BYTES } from './validation.ts';

export type AddEvidenceUseCase = (input: AddEvidenceInput) => Promise<Result<AddedEvidence, AddEvidenceError>>;

export const addEvidenceRoute = (addEvidence: AddEvidenceUseCase): RouteOptions => ({
  method: 'POST',
  url: '/dispute/:transactionId/evidence',
  bodyLimit: DISPUTE_BODY_LIMIT_BYTES,
  handler: async (request, reply) => {
    const path = parseRequest(zAddEvidencePath, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
    const body = parseRequest(zAddEvidenceBody, request.body);
    if (!body.ok) return sendProblem(reply, validationProblem(body.error, request.id));

    const result = await addEvidence({
      userId: userPrincipalOf(request).userId,
      transactionId: path.value.transactionId,
      evidence: body.value.evidence,
    });
    if (!result.ok) return sendProblem(reply, addEvidenceProblem(result.error, request.id));
    return reply.code(201).send(result.value);
  },
});
