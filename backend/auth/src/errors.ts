import { commonProblem, type ProblemBody } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { CallerError } from './core/caller.ts';
import type { InvalidReason, Principal } from './core/token.ts';

export const callerProblem = (error: CallerError, correlationId: string): ProblemBody => {
  switch (error) {
    case 'missing_token':
      return commonProblem('UNAUTHORIZED', 'Missing or malformed bearer token', correlationId);
    case 'invalid_token':
      return commonProblem('UNAUTHORIZED', 'Invalid token', correlationId);
    case 'user_token':
      return commonProblem('FORBIDDEN', 'Service token required', correlationId);
    case 'missing_scope':
      return commonProblem('FORBIDDEN', 'Missing required scope', correlationId);
    default:
      return assertNever(error);
  }
};

export type ValidateResponse =
  | ({ readonly valid: true } & Principal)
  | { readonly valid: false; readonly principalType: 'none'; readonly reason: InvalidReason };

export const validateResponse = (result: Result<Principal, InvalidReason>): ValidateResponse =>
  result.ok
    ? { valid: true, ...result.value }
    : { valid: false, principalType: 'none', reason: result.error };
