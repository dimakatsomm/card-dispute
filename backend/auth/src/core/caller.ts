import { err, ok, type Result } from '@cd/shared/fp';
import type { TokenSubject } from './token.ts';

export const VALIDATE_SCOPE = 'auth/validate';

export type CallerError = 'missing_token' | 'invalid_token' | 'user_token' | 'missing_scope';

export type ServiceCaller = { readonly clientId: string };

// Scheme is case-insensitive (RFC 7235); the cap bounds the work done on hostile input.
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]{1,8192}={0,2})$/i;

export const bearerToken = (header: string | undefined): string | undefined => BEARER.exec(header ?? '')?.[1];

export const authorizeCaller = (subject: TokenSubject): Result<ServiceCaller, CallerError> => {
  if (subject.kind !== 'service') return err('user_token');
  if (!subject.scopes.includes(VALIDATE_SCOPE)) return err('missing_scope');
  return ok({ clientId: subject.clientId });
};
