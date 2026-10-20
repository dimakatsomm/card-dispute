import { err, type Result } from '@cd/shared/fp';
import { authorizeCaller, bearerToken, type CallerError, type ServiceCaller } from '../core/caller.ts';
import {
  classifyClaims,
  type ClientAllowList,
  type SignatureRejection,
  type VerifiedClaims,
} from '../core/token.ts';

export type AuthenticateCallerDeps = {
  readonly verifyToken: (token: string) => Promise<Result<VerifiedClaims, SignatureRejection>>;
  readonly clients: ClientAllowList;
};

export type AuthenticateCallerInput = { readonly authorization: string | undefined };

export const authenticateCaller =
  (deps: AuthenticateCallerDeps) =>
  async (input: AuthenticateCallerInput): Promise<Result<ServiceCaller, CallerError>> => {
    const token = bearerToken(input.authorization);
    if (token === undefined) return err('missing_token');
    const verified = await deps.verifyToken(token);
    if (!verified.ok) return err('invalid_token');
    const subject = classifyClaims(verified.value, deps.clients);
    if (!subject.ok) return err('invalid_token');
    return authorizeCaller(subject.value);
  };
