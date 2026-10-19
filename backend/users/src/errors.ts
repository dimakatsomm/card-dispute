import { commonProblem, type ProblemBody } from '@cd/shared';
import { assertNever } from '@cd/shared/fp';
import type { GetContactError } from './use-cases/get-contact.ts';
import type { GetMeError } from './use-cases/get-me.ts';

export type UsersError = GetMeError | GetContactError;

export const toProblem = (error: UsersError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'NOT_FOUND':
      return commonProblem('NOT_FOUND', 'User not found', correlationId);
    default:
      return assertNever(error);
  }
};
