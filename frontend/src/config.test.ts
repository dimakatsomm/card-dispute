import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const valid = {
  apiBase: '/api',
  oidcIssuer: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_pool',
  oidcClientId: 'web-client',
  oidcRedirectUri: 'https://disputes.innocentia32.co.za/auth/callback',
  oidcLogoutUrl: 'https://auth.disputes.innocentia32.co.za/logout',
  oidcPostLogoutUri: 'https://disputes.innocentia32.co.za/',
};

describe('runtime config from window.__APP_CONFIG__ (/config.js)', () => {
  it('loads the values written by the container entrypoint', () => {
    expect(loadConfig({ __APP_CONFIG__: valid })).toEqual({ ok: true, value: valid });
  });

  it('accepts a plain-http local mock issuer', () => {
    const local = {
      ...valid,
      oidcIssuer: 'http://localhost:9000',
      oidcRedirectUri: 'http://localhost:5173/auth/callback',
      oidcLogoutUrl: 'http://localhost:9000/logout',
      oidcPostLogoutUri: 'http://127.0.0.1:5173/',
    };
    expect(loadConfig({ __APP_CONFIG__: local })).toEqual({ ok: true, value: local });
  });

  it.each([
    ['config.js not loaded', undefined, { kind: 'MISSING_CONFIG' }],
    ['an API on another origin', { ...valid, apiBase: 'https://evil.example/api' }, { kind: 'INVALID_FIELD', field: 'apiBase' }],
    ['a protocol-relative API base', { ...valid, apiBase: '//evil.example/api' }, { kind: 'INVALID_FIELD', field: 'apiBase' }],
    ['a backslash API base', { ...valid, apiBase: '/\\evil.example' }, { kind: 'INVALID_FIELD', field: 'apiBase' }],
    ['a plain-http remote issuer', { ...valid, oidcIssuer: 'http://issuer.example' }, { kind: 'INVALID_FIELD', field: 'oidcIssuer' }],
    ['a localhost look-alike issuer', { ...valid, oidcIssuer: 'http://localhost.evil.com' }, { kind: 'INVALID_FIELD', field: 'oidcIssuer' }],
    ['an empty client id', { ...valid, oidcClientId: '' }, { kind: 'INVALID_FIELD', field: 'oidcClientId' }],
    ['a missing logout URL', { ...valid, oidcLogoutUrl: undefined }, { kind: 'INVALID_FIELD', field: 'oidcLogoutUrl' }],
    ['a plain-http post-logout URI', { ...valid, oidcPostLogoutUri: 'http://disputes.example/' }, { kind: 'INVALID_FIELD', field: 'oidcPostLogoutUri' }],
  ])('rejects %s', (_case, source, error) => {
    expect(loadConfig({ __APP_CONFIG__: source })).toEqual({ ok: false, error });
  });
});
