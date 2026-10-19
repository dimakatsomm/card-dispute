import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLogger } from '../src/logger.ts';
import { sendProblem } from '../src/problem.ts';
import { parseRequest, validationProblem } from '../src/request.ts';
import { createServers, type Servers, type ServersOptions } from '../src/server.ts';

const GENERATED = 'generated-id-0001';
const amountSchema = z.object({ amount: z.string() });

const build = (overrides: Partial<ServersOptions> = {}) => {
  const lines: Array<Record<string, unknown>> = [];
  const destination = { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) };
  const servers = createServers({
    public: (app) => {
      app.get('/public-only', async (request) => {
        request.log.info('in-route');
        return { side: 'public' };
      });
      app.get('/boom', async () => {
        throw new Error('secret internals');
      });
      app.get('/unhandled-zod', async () => amountSchema.parse({ amount: 5 }));
      app.post('/validated', async (request, reply) => {
        const parsed = parseRequest(amountSchema, request.body);
        return parsed.ok ? parsed.value : sendProblem(reply, validationProblem(parsed.error, request.id));
      });
    },
    service: (app) => {
      app.get('/service-only', async () => ({ side: 'service' }));
    },
    logger: createLogger({ destination }),
    newId: () => GENERATED,
    ...overrides,
  });
  return { servers, lines };
};

let open: Servers | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('createServers', () => {
  it('serves health and ready on both ports', async () => {
    const { servers } = build();
    open = servers;
    for (const app of [servers.public, servers.service]) {
      expect((await app.inject('/health')).statusCode).toBe(200);
      expect((await app.inject('/ready')).statusCode).toBe(200);
    }
  });

  it.each([
    ['returns false', async () => false],
    ['throws', async () => Promise.reject(new Error('db down'))],
  ])('answers 503 problem+json on /ready when the readiness check %s', async (_label, ready) => {
    const { servers } = build({ ready });
    open = servers;
    const res = await servers.public.inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'NOT_READY', correlationId: GENERATED });
  });

  it('a route registered on one port is a 404 problem on the other', async () => {
    const { servers } = build();
    open = servers;
    expect((await servers.public.inject('/public-only')).statusCode).toBe(200);
    expect((await servers.service.inject('/public-only')).statusCode).toBe(404);
    expect((await servers.service.inject('/service-only')).statusCode).toBe(200);
    const res = await servers.public.inject('/service-only');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', status: 404, correlationId: GENERATED });
  });

  it('listens on two distinct ports', async () => {
    const { servers } = build({ ports: { public: 0, service: 0 } });
    open = servers;
    await servers.listen();
    const port = (a: ReturnType<typeof servers.public.server.address>) => (typeof a === 'object' && a ? a.port : 0);
    const pub = port(servers.public.server.address());
    const svc = port(servers.service.server.address());
    expect(pub).toBeGreaterThan(0);
    expect(svc).toBeGreaterThan(0);
    expect(pub).not.toBe(svc);
  });

  it('a route can turn parseRequest failures into a 400 VALIDATION_FAILED problem', async () => {
    const { servers } = build();
    open = servers;
    const bad = await servers.public.inject({ method: 'POST', url: '/validated', payload: { amount: 5 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'VALIDATION_FAILED', correlationId: GENERATED });
    expect(bad.json().detail).toContain('amount');
  });

  it('answers 500 without leaking internals for unexpected errors and unhandled ZodErrors', async () => {
    const { servers } = build();
    open = servers;
    for (const url of ['/boom', '/unhandled-zod']) {
      const res = await servers.public.inject(url);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(res.body).not.toContain('secret internals');
      expect(res.body).not.toContain('amount');
    }
  });

  it('preserves the framework 4xx status: malformed JSON is 400, oversized body is 413', async () => {
    const { servers } = build();
    open = servers;
    const malformed = await servers.public.inject({
      method: 'POST',
      url: '/validated',
      headers: { 'content-type': 'application/json' },
      payload: '{"amount":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'BAD_REQUEST', status: 400 });

    const huge = await servers.public.inject({
      method: 'POST',
      url: '/validated',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 'x'.repeat(1_100_000) }),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ code: 'HTTP_413', status: 413, correlationId: GENERATED });
  });

  it('closes both servers when listening fails', async () => {
    const taken = build({ ports: { public: 0, service: 0 } });
    await taken.servers.listen();
    const port = (taken.servers.public.server.address() as { port: number }).port;
    const { servers } = build({ ports: { public: 0, service: port } });
    await expect(servers.listen()).rejects.toThrow();
    expect(servers.public.server.listening).toBe(false);
    await taken.servers.close();
  });
});

describe('correlation id', () => {
  it('echoes a valid inbound id on the response and on every log line of the request', async () => {
    const { servers, lines } = build();
    open = servers;
    const res = await servers.public.inject({ url: '/public-only', headers: { 'x-correlation-id': 'abc-12345678' } });
    expect(res.headers['x-correlation-id']).toBe('abc-12345678');
    expect(lines.map((l) => l['msg'])).toContain('in-route');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l['correlationId'] === 'abc-12345678')).toBe(true);
  });

  it.each([
    ['CRLF injection', 'abcdefgh\r\nX-Injected: 1'],
    ['trailing newline', 'abcdefgh\n'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
  ])('replaces an invalid inbound id (%s)', async (_label, inbound) => {
    const { servers, lines } = build();
    open = servers;
    const res = await servers.public.inject({ url: '/public-only', headers: { 'x-correlation-id': inbound } });
    expect(res.headers['x-correlation-id']).toBe(GENERATED);
    expect(res.headers['x-injected']).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain('X-Injected');
  });

  it('generates an id when none is sent, including on 404 responses', async () => {
    const { servers } = build();
    open = servers;
    const res = await servers.public.inject('/nope');
    expect(res.headers['x-correlation-id']).toBe(GENERATED);
  });
});
