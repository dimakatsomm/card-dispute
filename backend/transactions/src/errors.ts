import { problemBody, type ProblemBody } from '@cd/shared';
import { assertNever } from '@cd/shared/fp';
import type { ListTransactionsError } from './use-cases/list-transactions.ts';

export const listTransactionsProblem = (error: ListTransactionsError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'INVALID_CURSOR':
      return problemBody({
        status: 400,
        title: 'Validation Failed',
        code: 'INVALID_CURSOR',
        detail: 'cursor: not a cursor issued by this API',
        correlationId,
      });
    default:
      return assertNever(error);
  }
};
