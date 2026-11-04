import { agentPrincipalOf } from '@cd/auth-client';
import {
  zGetAgentDisputePath,
  zListReviewQueueQuery,
  zResolveDisputeBody,
  zReviewDisputeBody,
  zReviewDisputePath,
} from '@cd/contracts/disputes.public';
import { queryOf } from '@cd/contracts/query';
import {
  commonProblem,
  parseRequest,
  problemBody,
  sendProblem,
  validationProblem,
  type ProblemBody,
} from '@cd/shared';
import { assertNever, ok, type Result } from '@cd/shared/fp';
import type { RouteOptions } from 'fastify';
import type { z } from 'zod';
import type { AgentDecision } from '../core/agent-decision.ts';
import type { CursorError } from '../core/cursor.ts';
import type { AgentDisputeDetail, ReviewQueuePage } from '../core/types.ts';
import type { GetAgentDisputeError, GetAgentDisputeInput } from '../use-cases/agent-dispute.ts';
import type { DecideDisputeError, DecideDisputeInput } from '../use-cases/decide-dispute.ts';
import type { ReviewQueueInput } from '../use-cases/review-queue.ts';
import { DISPUTE_BODY_LIMIT_BYTES } from './validation.ts';

export type AgentUseCases = {
  readonly listReviewQueue: (input: ReviewQueueInput) => Promise<Result<ReviewQueuePage, CursorError>>;
  readonly getAgentDispute: (
    input: GetAgentDisputeInput,
  ) => Promise<Result<AgentDisputeDetail, GetAgentDisputeError>>;
  readonly decideDispute: (
    input: DecideDisputeInput,
  ) => Promise<Result<AgentDisputeDetail, DecideDisputeError>>;
};

const queueQuery = queryOf(zListReviewQueueQuery);

const notFound = (correlationId: string): ProblemBody =>
  commonProblem('NOT_FOUND', 'Dispute not found', correlationId);

export const decideDisputeProblem = (error: DecideDisputeError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'NOT_FOUND':
      return notFound(correlationId);
    case 'STALE_VERSION':
      return problemBody({
        status: 412,
        title: 'Precondition Failed',
        code: 'STALE_VERSION',
        detail: 'The dispute changed since it was read; reload',
        correlationId,
      });
    case 'STALE_EVIDENCE':
      return problemBody({
        status: 412,
        title: 'Precondition Failed',
        code: 'STALE_EVIDENCE',
        detail: 'The evidence changed since it was read; reload',
        correlationId,
      });
    case 'INVALID_TRANSITION':
      return problemBody({
        status: 409,
        title: 'Conflict',
        code: 'INVALID_TRANSITION',
        detail: 'The dispute cannot change in its current status',
        correlationId,
      });
    default:
      return assertNever(error);
  }
};

const reviewQueueRoute = (useCases: AgentUseCases): RouteOptions => ({
  method: 'GET',
  url: '/agent/review-queue',
  handler: async (request, reply) => {
    const query = parseRequest(queueQuery, request.query);
    if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
    const { status, limit, cursor } = query.value;
    const result = await useCases.listReviewQueue({ statuses: status, limit, cursor });
    if (!result.ok) {
      return sendProblem(
        reply,
        problemBody({
          status: 400,
          title: 'Validation Failed',
          code: 'INVALID_CURSOR',
          detail: 'cursor: not a cursor issued by this API',
          correlationId: request.id,
        }),
      );
    }
    return reply.code(200).send(result.value);
  },
});

const agentDisputeRoute = (useCases: AgentUseCases): RouteOptions => ({
  method: 'GET',
  url: '/agent/disputes/:transactionId',
  handler: async (request, reply) => {
    const path = parseRequest(zGetAgentDisputePath, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
    const result = await useCases.getAgentDispute({
      transactionId: path.value.transactionId,
      correlationId: request.id,
    });
    if (!result.ok) return sendProblem(reply, notFound(request.id));
    // Read audit (ADR-071): ids only, never customer data.
    request.log.info(
      { agentId: agentPrincipalOf(request).agentId, disputeId: result.value.disputeId },
      'agent dispute viewed',
    );
    return reply.code(200).send(result.value);
  },
});

type ParsedDecision = {
  readonly decision: AgentDecision;
  readonly expectedVersion: number;
  readonly expectedEvidenceDigest: string;
};

type ParseDecision = (body: unknown) => Result<ParsedDecision, z.ZodError>;

const parseReview: ParseDecision = (body) => {
  const parsed = parseRequest(zReviewDisputeBody, body);
  return parsed.ok ? ok({ ...parsed.value, decision: { type: 'REVIEW' } }) : parsed;
};

const parseResolution: ParseDecision = (body) => {
  const parsed = parseRequest(zResolveDisputeBody, body);
  if (!parsed.ok) return parsed;
  const { outcome, note, expectedVersion, expectedEvidenceDigest } = parsed.value;
  return ok({ decision: { type: 'RESOLVE', outcome, note }, expectedVersion, expectedEvidenceDigest });
};

const decisionRoute = (useCases: AgentUseCases, url: string, parseDecision: ParseDecision): RouteOptions => ({
  method: 'PUT',
  url,
  bodyLimit: DISPUTE_BODY_LIMIT_BYTES,
  handler: async (request, reply) => {
    const path = parseRequest(zReviewDisputePath, request.params);
    if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
    const body = parseDecision(request.body);
    if (!body.ok) return sendProblem(reply, validationProblem(body.error, request.id));
    const result = await useCases.decideDispute({
      ...body.value,
      agentId: agentPrincipalOf(request).agentId,
      agentName: agentPrincipalOf(request).displayName,
      transactionId: path.value.transactionId,
      correlationId: request.id,
    });
    if (!result.ok) return sendProblem(reply, decideDisputeProblem(result.error, request.id));
    return reply.code(200).send(result.value);
  },
});

export const agentRoutes = (useCases: AgentUseCases): ReadonlyArray<RouteOptions> => [
  reviewQueueRoute(useCases),
  agentDisputeRoute(useCases),
  decisionRoute(useCases, '/agent/disputes/:transactionId/review', parseReview),
  decisionRoute(useCases, '/agent/disputes/:transactionId/resolution', parseResolution),
];
