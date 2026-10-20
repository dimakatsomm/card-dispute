import { commonProblem, problemBody, type ProblemBody } from '@cd/shared';
import { assertNever } from '@cd/shared/fp';
import type { CreateDisputeError } from './use-cases/create-dispute.ts';

const notEligible = (code: string, correlationId: string): ProblemBody => ({
  ...problemBody({
    status: 422,
    title: 'Not Eligible',
    code,
    detail: 'The transaction cannot be disputed',
    correlationId,
  }),
  type: 'urn:cd:problem:NOT_ELIGIBLE',
});

export const createDisputeProblem = (error: CreateDisputeError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'NOT_FOUND':
      return commonProblem('NOT_FOUND', 'Transaction not found', correlationId);
    case 'ALREADY_DISPUTED':
      return problemBody({
        status: 409,
        title: 'Conflict',
        code: 'ALREADY_DISPUTED',
        detail: 'A dispute already exists for this transaction',
        correlationId,
      });
    case 'CARD_EXPIRED':
    case 'TXN_NOT_POSTED':
    case 'TXN_TYPE_NOT_DISPUTABLE':
    case 'OUTSIDE_WINDOW':
      return notEligible(error, correlationId);
    case 'INVALID_REASON':
    case 'INVALID_DESCRIPTION':
      return problemBody({
        status: 400,
        title: 'Validation Failed',
        code: error,
        detail: 'The dispute input is not valid',
        correlationId,
      });
    case 'UPSTREAM_UNAVAILABLE':
      return problemBody({
        status: 503,
        title: 'Service Unavailable',
        code: 'UPSTREAM_UNAVAILABLE',
        detail: 'A dependency is temporarily unavailable',
        correlationId,
      });
    case 'UPLOAD_SIGNING_UNAVAILABLE':
      return problemBody({
        status: 503,
        title: 'Service Unavailable',
        code: 'UPLOAD_SIGNING_UNAVAILABLE',
        detail: 'The dispute was created but upload URLs could not be issued; request them again later',
        correlationId,
      });
    default:
      return assertNever(error);
  }
};
