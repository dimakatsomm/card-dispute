import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwksFetcher } from '../../src/adapters/jwt-verifier.ts';

const JWKS = JSON.stringify({ keys: [] });
const OVERSIZED = 'x'.repeat(70 * 1024);

const routes: Readonly<Record<string, (res: ServerResponse) => void>> = {
  '/ok': (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JWKS),
  '/redirect': (res) => res.writeHead(302, { location: '/ok' }).end(),
  '/html': (res) => res.writeHead(200, { 'content-type': 'text/html' }).end(JWKS),
  '/not-found': (res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{}'),
  '/declared-large': (res) =>
    res
      .writeHead(200, { 'content-type': 'application/json', 'content-length': OVERSIZED.length })
      .end(OVERSIZED),
  '/chunked-large': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(OVERSIZED.slice(0, 40 * 1024));
    res.end(OVERSIZED.slice(40 * 1024));
  },
};

const server = createServer((req, res) => (routes[req.url ?? ''] ?? ((r) => r.writeHead(404).end()))(res));
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const insecureOk = createJwksFetcher({ fetch, allowInsecureJwks: true });

describe('JWKS fetcher', () => {
  it('returns a small JSON JWKS', async () => {
    const body = await insecureOk.fetch(`${base}/ok`);
    expect(new TextDecoder().decode(body)).toBe(JWKS);
  });

  it.each([
    ['a redirect', '/redirect'],
    ['a non-JSON content type', '/html'],
    ['a non-200 status', '/not-found'],
    ['a declared content-length over 64 KB', '/declared-large'],
    ['a chunked body over 64 KB', '/chunked-large'],
  ])('rejects %s', async (_name, path) => {
    await expect(insecureOk.fetch(`${base}${path}`)).rejects.toThrow();
  });

  it.each([
    [
      'http without AUTH_ALLOW_INSECURE_JWKS',
      createJwksFetcher({ fetch, allowInsecureJwks: false }),
      () => `${base}/ok`,
    ],
    ['a non-http scheme even when insecure is allowed', insecureOk, () => 'file:///etc/passwd'],
  ])('refuses %s', async (_name, fetcher, uri) => {
    await expect(fetcher.fetch(uri())).rejects.toThrow(/scheme not allowed/);
  });
});
