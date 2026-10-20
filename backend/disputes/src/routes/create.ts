import { userPrincipalOf } from '@cd/auth-client';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import type { Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import { z } from 'zod';
import { EVIDENCE_CONTENT_TYPES } from '../core/types.ts';
import { createDisputeProblem } from '../errors.ts';
import type { CreateDisputeError, CreateDisputeInput, CreatedDispute } from '../use-cases/create-dispute.ts';

export const MAX_EVIDENCE_PER_REQUEST = 5;
export const MAX_EVIDENCE_BYTES = 10_485_760;

const evidenceDeclaration = z.strictObject({
  // Display-only name, but control characters could forge log lines or UI text.
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\p{Cc}]+$/u),
  contentType: z.enum(EVIDENCE_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_EVIDENCE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

// Strict: an unknown field such as disputedAmount is a 400, so partial disputes cannot be expressed (ADR-024).
const createBody = z.strictObject({
  reasonCode: z.string(),
  description: z.string(),
  evidence: z.array(evidenceDeclaration).max(MAX_EVIDENCE_PER_REQUEST).optional(),
});

const params = z.object({ transactionId: z.uuid() });

export type CreateDisputeUseCase = (
  input: CreateDisputeInput,
) => Promise<Result<CreatedDispute, CreateDisputeError>>;

export const createDisputeRoute = (createDispute: CreateDisputeUseCase): RouteOptions => ({
  method: 'POST',
  url: '/dispute/:transactionId',
  handler: async (request, reply) => {
    const path = parseRequest(params, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
    const body = parseRequest(createBody, request.body);
    if (!body.ok) return sendProblem(reply, validationProblem(body.error, request.id));

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
