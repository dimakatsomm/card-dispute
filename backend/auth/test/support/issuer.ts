import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ISSUER = 'http://localhost:55900';
export const USER_CLIENTS = ['spa'] as const;
export const SERVICE_CLIENTS = ['svc-users', 'svc-transactions', 'svc-disputes', 'svc-notifier'] as const;

export type TestKey = { readonly privateKey: KeyObject; readonly kid: string };

export const newKey = (kid: string): TestKey => ({
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
  kid,
});

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export const signJwt = (key: TestKey, claims: Readonly<Record<string, unknown>>, kid = key.kid): string => {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.${b64url(sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.privateKey))}`;
};

export const unsignedJwt = (
  header: Readonly<Record<string, unknown>>,
  claims: Readonly<Record<string, unknown>>,
): string => `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.`;

// Classic alg-confusion forgery: HMAC keyed with the issuer's public key bytes.
export const hs256WithPublicKey = (key: TestKey, claims: Readonly<Record<string, unknown>>): string => {
  const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid }))}.${b64url(JSON.stringify(claims))}`;
  const secret = createPublicKey(key.privateKey).export({ format: 'pem', type: 'spki' });
  return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const accessClaims = (overrides: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
  token_use: 'access',
  iss: ISSUER,
  iat: nowSeconds(),
  exp: nowSeconds() + 900,
  jti: randomUUID(),
  ...overrides,
});

export const userClaims = (sub: string, overrides: Readonly<Record<string, unknown>> = {}) =>
  accessClaims({ sub, client_id: 'spa', scope: 'openid profile email', ...overrides });

export const serviceClaims = (
  clientId: string,
  scope: string,
  overrides: Readonly<Record<string, unknown>> = {},
) => accessClaims({ client_id: clientId, scope, ...overrides });

export type JwksServer = { readonly url: string; readonly close: () => Promise<void> };

export const startJwksServer = async (keys: ReadonlyArray<TestKey>): Promise<JwksServer> => {
  const jwks = JSON.stringify({
    keys: keys.map((k) => ({
      ...createPublicKey(k.privateKey).export({ format: 'jwk' }),
      kid: k.kid,
      alg: 'RS256',
      use: 'sig',
    })),
  });
  const server = createServer((req, res) => {
    if (req.url !== '/.well-known/jwks.json') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(jwks);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
};
