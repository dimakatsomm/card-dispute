import { loadConfig } from '@cd/shared';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/main.ts';

const base = {
  DATABASE_URL: 'postgres://auth_app:fake@db:5432/cd',
  AUTH_ISSUER_URL: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_pool',
  AUTH_USER_CLIENT_IDS: 'spa',
  AUTH_SERVICE_CLIENT_IDS: 'svc-users,svc-disputes',
};

describe('auth configuration', () => {
  it.each<[string, Record<string, string>, RegExp | null]>([
    ['https issuer', {}, null],
    ['http issuer without the flag', { AUTH_ISSUER_URL: 'http://localhost:55900' }, /AUTH_ISSUER_URL/],
    [
      'http JWKS URI without the flag',
      { AUTH_JWKS_URI: 'http://mock-issuer:55900/.well-known/jwks.json' },
      /AUTH_JWKS_URI/,
    ],
    [
      'http issuer and JWKS with AUTH_ALLOW_INSECURE_JWKS=true',
      {
        AUTH_ISSUER_URL: 'http://localhost:55900',
        AUTH_JWKS_URI: 'http://mock-issuer:55900/.well-known/jwks.json',
        AUTH_ALLOW_INSECURE_JWKS: 'true',
      },
      null,
    ],
    ['a client id on both allow-lists', { AUTH_USER_CLIENT_IDS: 'spa,svc-users' }, /AUTH_SERVICE_CLIENT_IDS/],
  ])('%s', (_name, overrides, error) => {
    const load = () => loadConfig(configSchema, { ...base, ...overrides });
    if (error === null) expect(load).not.toThrow();
    else expect(load).toThrow(error);
  });
});
