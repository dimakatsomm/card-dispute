import { createHash, createPublicKey, randomUUID, sign } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

export type Claims = Readonly<Record<string, unknown>>;

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export const keyId = (privateKey: KeyObject): string => {
  const { n, e } = createPublicKey(privateKey).export({ format: 'jwk' });
  return createHash('sha256').update(`${e}.${n}`).digest('base64url').slice(0, 16);
};

export const buildJwks = (privateKey: KeyObject): { readonly keys: ReadonlyArray<JsonWebKey> } => {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: keyId(privateKey), alg: 'RS256', use: 'sig' }] };
};

export const signJwt = (privateKey: KeyObject, claims: Claims): string => {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyId(privateKey) }));
  const payload = b64url(JSON.stringify(claims));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
};

type AccessTokenInput = {
  readonly issuer: string;
  readonly clientId: string;
  readonly scope: string;
  readonly nowSeconds: number;
  readonly ttlSeconds: number;
  readonly sub?: string;
  readonly username?: string;
};

export const accessTokenClaims = (i: AccessTokenInput): Claims => ({
  ...(i.sub ? { sub: i.sub } : {}),
  ...(i.username ? { username: i.username } : {}),
  token_use: 'access',
  client_id: i.clientId,
  scope: i.scope,
  iss: i.issuer,
  iat: i.nowSeconds,
  exp: i.nowSeconds + i.ttlSeconds,
  jti: randomUUID(),
});

type IdTokenInput = {
  readonly issuer: string;
  readonly clientId: string;
  readonly sub: string;
  readonly username: string;
  readonly nonce: string | null;
  readonly nowSeconds: number;
  readonly ttlSeconds: number;
};

export const idTokenClaims = (i: IdTokenInput): Claims => ({
  sub: i.sub,
  'cognito:username': i.username,
  token_use: 'id',
  aud: i.clientId,
  iss: i.issuer,
  iat: i.nowSeconds,
  exp: i.nowSeconds + i.ttlSeconds,
  ...(i.nonce ? { nonce: i.nonce } : {}),
});
