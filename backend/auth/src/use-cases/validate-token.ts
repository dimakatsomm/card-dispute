import { ok, type Result } from '@cd/shared/fp';
import {
  classifyClaims,
  servicePrincipal,
  userPrincipal,
  type ClientAllowList,
  type Identity,
  type InvalidReason,
  type Principal,
  type SignatureRejection,
  type VerifiedClaims,
} from '../core/token.ts';

export type ValidateTokenDeps = {
  readonly verifyToken: (token: string) => Promise<Result<VerifiedClaims, SignatureRejection>>;
  readonly findIdentityBySub: (cognitoSub: string) => Promise<Identity | null>;
  readonly clients: ClientAllowList;
};

export const validateToken =
  (deps: ValidateTokenDeps) =>
  async (token: string): Promise<Result<Principal, InvalidReason>> => {
    const verified = await deps.verifyToken(token);
    if (!verified.ok) return verified;
    const subject = classifyClaims(verified.value, deps.clients);
    if (!subject.ok) return subject;
    if (subject.value.kind === 'service') return ok(servicePrincipal(subject.value));
    return userPrincipal(subject.value, await deps.findIdentityBySub(subject.value.sub));
  };
