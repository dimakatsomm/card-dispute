import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeClaims, signIn, tokenFor } from '../src/auth.ts';
import { env } from '../src/env.ts';
import { api } from '../src/http.ts';

let tokenA: string;

beforeAll(async () => {
  tokenA = await tokenFor('A');
});

describe('Cognito e2e client (ADR-062)', () => {
  it('signs user A in through IAM-signed AdminInitiateAuth and yields a user access token', async () => {
    const claims = decodeClaims(tokenA);
    expect(claims['token_use']).toBe('access');
    expect(claims['client_id']).toBe(env().e2eClientId);
    expect(String(claims['iss'])).toMatch(new RegExp(`/${env().userPoolId}$`));
    expect(claims['sub']).toBeTypeOf('string');
  });

  // V-09: only claim names and non-secret values are recorded, never the token.
  it('records the access token claim names for V-09', () => {
    const claims = decodeClaims(tokenA);
    const record = {
      claimNames: Object.keys(claims).sort(),
      token_use: claims['token_use'],
      scope: claims['scope'] ?? null,
    };
    console.info(`V-09 access token claims: ${JSON.stringify(record)}`);
    expect(record.claimNames).toEqual(
      expect.arrayContaining(['sub', 'iss', 'client_id', 'token_use', 'exp']),
    );
  });

  it('the disabled user D cannot sign in', async () => {
    const result = await signIn('D');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorName).toBe('NotAuthorizedException');
      expect(/User is disabled/.test(result.errorMessage), 'sign-in refusal is about a disabled user').toBe(
        true,
      );
    }
  });
});

describe('public API over CloudFront', () => {
  it('rejects a request without a token and a bearer value that is not a JWT with 401', async () => {
    expect((await api('GET', '/me')).status).toBe(401);
    expect((await api('GET', '/me', { token: 'not-a-jwt' })).status).toBe(401);
  });

  it('serves GET /me to the token holder', async () => {
    const reply = await api('GET', '/me', { token: tokenA });
    expect(reply.status).toBe(200);
    expect(Array.isArray(reply.body['accounts']), 'accounts is an array').toBe(true);
  });
});

describe('service-only paths are not reachable through CloudFront (ADR-026)', () => {
  const id = randomUUID();
  const evidencePath = `/dispute/${randomUUID()}/evidence/${randomUUID()}`;

  it.each([
    ['GET', `/users/${id}/contact`],
    ['GET', `/cards?userId=${id}`],
    ['GET', '/review-queue'],
    ['GET', '/validate'],
    ['PUT', `/dispute/${id}/review`],
    ['PUT', `/dispute/${id}/resolution`],
  ])('%s /api%s with a valid user token gets 404', async (method, path) => {
    const body = method === 'PUT' ? { action: 'X' } : undefined;
    const reply = await api(method, path, { token: tokenA, ...(body !== undefined ? { body } : {}) });
    expect(reply.status).toBe(404);
  });

  it('PUT /api/dispute/{tx}/evidence/{id} (intake result route) gets 404, not 401, 403 or a state change', async () => {
    const reply = await api('PUT', evidencePath, {
      token: tokenA,
      body: { result: 'REJECTED', reason: 'MALWARE' },
    });
    expect(reply.status).toBe(404);
  });

  it('the same service-only paths without any token are not served either', async () => {
    for (const path of [`/users/${id}/contact`, '/cards', '/review-queue']) {
      const reply = await api('GET', path);
      expect(reply.status, `GET ${path.split('?')[0]?.replace(id, '{id}')}`).toBe(404);
      const leaked = typeof reply.body === 'object' && reply.body !== null && 'email' in reply.body;
      expect(leaked, 'response carries an email field').toBe(false);
    }
  });
});
