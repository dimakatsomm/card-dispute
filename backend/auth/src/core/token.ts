import { err, ok, type Result } from '@cd/shared/fp';

export type InvalidReason =
  | 'expired'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_client'
  | 'wrong_token_use'
  | 'unknown_subject'
  | 'disabled';

export type SignatureRejection = Extract<InvalidReason, 'expired' | 'bad_signature' | 'wrong_issuer'>;

export type VerifiedClaims = {
  readonly tokenUse: string | undefined;
  readonly clientId: string | undefined;
  readonly sub: string | undefined;
  readonly scope: string | undefined;
  readonly exp: number | undefined;
};

export type ClientIds = {
  readonly user: ReadonlyArray<string>;
  readonly service: ReadonlyArray<string>;
};

// Branded so the disjointness check in clientAllowList cannot be bypassed.
export type ClientAllowList = ClientIds & { readonly __brand: 'ClientAllowList' };

export type AllowListError = 'empty_allow_list' | 'overlapping_client_ids';

export const clientAllowList = (ids: ClientIds): Result<ClientAllowList, AllowListError> => {
  if (ids.user.length === 0 || ids.service.length === 0) return err('empty_allow_list');
  if (ids.user.some((id) => ids.service.includes(id))) return err('overlapping_client_ids');
  return ok({ user: [...ids.user], service: [...ids.service], __brand: 'ClientAllowList' });
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
    };

export type IdentityStatus = 'ACTIVE' | 'DISABLED';

export type Identity = {
  readonly authId: string;
  readonly userId: string;
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
    };

export const parseScopes = (scope: string | undefined): ReadonlyArray<string> =>
  (scope ?? '').split(' ').filter((s) => s !== '');

// The client decides the principal type: real Cognito client_credentials tokens carry sub = client_id.
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
  if (clientId === undefined || !clients.user.includes(clientId)) return err('wrong_client');
  if (claims.sub === undefined || claims.sub === '') return err('unknown_subject');
  return ok({ kind: 'user', sub: claims.sub, scopes, exp });
};

export const userPrincipal = (
  subject: Extract<TokenSubject, { kind: 'user' }>,
  identity: Identity | null,
): Result<Principal, Extract<InvalidReason, 'unknown_subject' | 'disabled'>> => {
  if (identity === null) return err('unknown_subject');
  if (identity.status !== 'ACTIVE') return err('disabled');
  return ok({
    principalType: 'user',
    authId: identity.authId,
    userId: identity.userId,
    scopes: subject.scopes,
    exp: subject.exp,
  });
};

export const servicePrincipal = (subject: Extract<TokenSubject, { kind: 'service' }>): Principal => ({
  principalType: 'service',
  clientId: subject.clientId,
  scopes: subject.scopes,
  exp: subject.exp,
});
