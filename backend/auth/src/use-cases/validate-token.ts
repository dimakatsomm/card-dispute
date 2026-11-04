import { ok, type Result } from '@cd/shared/fp';
import {
  agentPrincipal,
  classifyClaims,
  servicePrincipal,
  userPrincipal,
  type AgentIdentity,
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
  readonly findAgentBySub: (cognitoSub: string) => Promise<AgentIdentity | null>;
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
    const [identity, agent] = await Promise.all([
      deps.findIdentityBySub(subject.value.sub),
      deps.findAgentBySub(subject.value.sub),
    ]);
    return subject.value.kind === 'agent'
      ? agentPrincipal(subject.value, agent, identity)
      : userPrincipal(subject.value, identity, agent);
  };
