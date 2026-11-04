import { err, ok, type Result } from '@cd/shared/fp';

export type InvalidReason =
  | 'expired'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_client'
  | 'wrong_token_use'
  | 'unknown_subject'
  | 'disabled'
  | 'ambiguous_role';

export type SignatureRejection = Extract<InvalidReason, 'expired' | 'bad_signature' | 'wrong_issuer'>;

export type VerifiedClaims = {
  readonly tokenUse: string | undefined;
  readonly clientId: string | undefined;
  readonly sub: string | undefined;
  readonly scope: string | undefined;
  readonly exp: number | undefined;
  readonly groups: ReadonlyArray<string> | undefined;
};

export const AGENTS_GROUP = 'agents';

export type ClientIds = {
  readonly user: ReadonlyArray<string>;
  readonly service: ReadonlyArray<string>;
  readonly agent: ReadonlyArray<string>;
};

// Branded so the disjointness check in clientAllowList cannot be bypassed.
export type ClientAllowList = ClientIds & { readonly __brand: 'ClientAllowList' };

export type AllowListError = 'empty_allow_list' | 'overlapping_client_ids';

const overlaps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.some((id) => b.includes(id));

export const clientAllowList = (ids: ClientIds): Result<ClientAllowList, AllowListError> => {
  if (ids.user.length === 0 || ids.service.length === 0 || ids.agent.length === 0)
    return err('empty_allow_list');
  if (overlaps(ids.user, ids.service) || overlaps(ids.user, ids.agent) || overlaps(ids.service, ids.agent)) {
    return err('overlapping_client_ids');
  }
  return ok({
    user: [...ids.user],
    service: [...ids.service],
    agent: [...ids.agent],
    __brand: 'ClientAllowList',
  });
};

export type TokenSubject =
  | {
      readonly kind: 'user';
      readonly sub: string;
      readonly scopes: ReadonlyArray<string>;
      readonly exp: number;
    }
  | {
      readonly kind: 'service';
      readonly clientId: string;
      readonly scopes: ReadonlyArray<string>;
      readonly exp: number;
    }
  | {
      readonly kind: 'agent';
      readonly sub: string;
      readonly exp: number;
    };

export type IdentityStatus = 'ACTIVE' | 'DISABLED';

export type Identity = {
  readonly authId: string;
  readonly userId: string;
  readonly status: IdentityStatus;
};

export type AgentIdentity = {
  readonly agentId: string;
  readonly status: IdentityStatus;
};

export type Principal =
  | {
      readonly principalType: 'user';
      readonly authId: string;
      readonly userId: string;
      readonly scopes: ReadonlyArray<string>;
      readonly exp: number;
    }
  | {
      readonly principalType: 'service';
      readonly clientId: string;
      readonly scopes: ReadonlyArray<string>;
      readonly exp: number;
    }
  | {
      readonly principalType: 'agent';
      readonly agentId: string;
      readonly scopes: ReadonlyArray<string>;
      readonly exp: number;
    };

export const parseScopes = (scope: string | undefined): ReadonlyArray<string> =>
  (scope ?? '').split(' ').filter((s) => s !== '');

// The client decides the principal type: real Cognito client_credentials tokens carry sub = client_id,
// and real Cognito puts cognito:groups on spa tokens too, so the group only counts on an agent client.
export const classifyClaims = (
  claims: VerifiedClaims,
  clients: ClientAllowList,
): Result<
  TokenSubject,
  Extract<InvalidReason, 'expired' | 'wrong_token_use' | 'wrong_client' | 'unknown_subject'>
> => {
  if (claims.tokenUse !== 'access') return err('wrong_token_use');
  // The verifier only checks exp when present; a token without one would never expire.
  if (claims.exp === undefined) return err('expired');
  const { clientId, exp } = claims;
  const scopes = parseScopes(claims.scope);
  if (clientId !== undefined && clients.service.includes(clientId)) {
    return ok({ kind: 'service', clientId, scopes, exp });
  }
  const isAgentClient = clientId !== undefined && clients.agent.includes(clientId);
  if (!isAgentClient && (clientId === undefined || !clients.user.includes(clientId)))
    return err('wrong_client');
  if (claims.sub === undefined || claims.sub === '') return err('unknown_subject');
  if (!isAgentClient) return ok({ kind: 'user', sub: claims.sub, scopes, exp });
  if (!(claims.groups ?? []).includes(AGENTS_GROUP)) return err('unknown_subject');
  return ok({ kind: 'agent', sub: claims.sub, exp });
};

type LookupRejection = Extract<InvalidReason, 'unknown_subject' | 'disabled' | 'ambiguous_role'>;

// One login, one role (ADR-071): a sub in both identity tables is refused on either path.
export const userPrincipal = (
  subject: Extract<TokenSubject, { kind: 'user' }>,
  identity: Identity | null,
  agent: AgentIdentity | null,
): Result<Principal, LookupRejection> => {
  if (identity === null) return err('unknown_subject');
  if (agent !== null) return err('ambiguous_role');
  if (identity.status !== 'ACTIVE') return err('disabled');
  return ok({
    principalType: 'user',
    authId: identity.authId,
    userId: identity.userId,
    scopes: subject.scopes,
    exp: subject.exp,
  });
};

export const agentPrincipal = (
  subject: Extract<TokenSubject, { kind: 'agent' }>,
  agent: AgentIdentity | null,
  identity: Identity | null,
): Result<Principal, LookupRejection> => {
  if (agent === null) return err('unknown_subject');
  if (identity !== null) return err('ambiguous_role');
  if (agent.status !== 'ACTIVE') return err('disabled');
  return ok({ principalType: 'agent', agentId: agent.agentId, scopes: [], exp: subject.exp });
};

export const servicePrincipal = (subject: Extract<TokenSubject, { kind: 'service' }>): Principal => ({
  principalType: 'service',
  clientId: subject.clientId,
  scopes: subject.scopes,
  exp: subject.exp,
});
