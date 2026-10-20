import { userPrincipalOf } from '@cd/auth-client';
import {
  commonProblem,
  parseRequest,
  problemBody,
  sendProblem,
  validationProblem,
  type ProblemBody,
} from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import { z } from 'zod';
import type { DisputeResource } from '../core/types.ts';
import type { UpdateAction, UpdateDisputeError, UpdateDisputeInput } from '../use-cases/update-dispute.ts';

// Strict, so disputedAmount is a 400 (ADR-024).
const editBody = z
  .strictObject({
    action: z.literal('EDIT'),
    reasonCode: z.string().optional(),
    description: z.string().optional(),
  })
  .refine((b) => b.reasonCode !== undefined || b.description !== undefined, {
    message: 'EDIT needs reasonCode or description',
  });

const withdrawBody = z.strictObject({
  action: z.literal('WITHDRAW'),
  note: z.string().max(500).optional(),
});

const updateBody = z.discriminatedUnion('action', [editBody, withdrawBody]);

const params = z.object({ transactionId: z.uuid() });

const QUOTED_VERSION = /^"([1-9][0-9]{0,8})"$/;

export type UpdateDisputeUseCase = (
  input: UpdateDisputeInput,
) => Promise<Result<DisputeResource, UpdateDisputeError>>;

const problem = (status: number, title: string, code: string, detail: string, correlationId: string) =>
  problemBody({ status, title, code, detail, correlationId });

const preconditionFailed = (correlationId: string): ProblemBody =>
  problem(
    412,
    'Precondition Failed',
    'PRECONDITION_FAILED',
    'If-Match does not match the current version',
    correlationId,
  );

export const updateDisputeProblem = (error: UpdateDisputeError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'NOT_FOUND':
      return commonProblem('NOT_FOUND', 'Dispute not found', correlationId);
    case 'STALE_VERSION':
      return preconditionFailed(correlationId);
    case 'INVALID_TRANSITION':
      return problem(
        409,
        'Conflict',
        'INVALID_TRANSITION',
        'The dispute cannot change in its current status',
        correlationId,
      );
    case 'INVALID_REASON':
    case 'INVALID_DESCRIPTION':
      return problem(400, 'Bad Request', error, 'The edited dispute is not valid', correlationId);
    default:
      return assertNever(error);
  }
};

const toAction = (body: z.output<typeof updateBody>): UpdateAction =>
  body.action === 'EDIT'
    ? {
        type: 'EDIT',
        ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
        ...(body.description === undefined ? {} : { description: body.description }),
      }
    : { type: 'WITHDRAW', ...(body.note === undefined ? {} : { note: body.note }) };

export const updateDisputeRoute = (updateDispute: UpdateDisputeUseCase): RouteOptions => ({
  method: 'PUT',
  url: '/dispute/:transactionId',
  handler: async (request, reply) => {
    const path = parseRequest(params, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
    const ifMatch = request.headers['if-match'];
    if (ifMatch === undefined) {
      return sendProblem(
        reply,
        problem(428, 'Precondition Required', 'PRECONDITION_REQUIRED', 'If-Match is required', request.id),
      );
    }
    const body = parseRequest(updateBody, request.body);
    if (!body.ok) return sendProblem(reply, validationProblem(body.error, request.id));
    // Anything but a quoted version (including "*") can never match, so it is stale rather than a bypass.
    const version = QUOTED_VERSION.exec(ifMatch)?.[1];
    if (version === undefined) return sendProblem(reply, preconditionFailed(request.id));

    const result = await updateDispute({
      userId: userPrincipalOf(request).userId,
      transactionId: path.value.transactionId,
      expectedVersion: Number(version),
      action: toAction(body.value),
      correlationId: request.id,
    });
    if (!result.ok) return sendProblem(reply, updateDisputeProblem(result.error, request.id));
    return reply.code(200).header('etag', `"${result.value.version}"`).send(result.value);
  },
});
