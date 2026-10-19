import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, type Fetch } from '../src/http-client.ts';
import { fakeFetch, jsonResponse } from './fakes.ts';

afterEach(() => {
  vi.useRealTimers();
});

const neverResolvesUntilAborted: Fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });

describe('createHttpClient', () => {
  it('forwards x-correlation-id', async () => {
    const stub = fakeFetch(() => jsonResponse(200, { ok: true }));
    const result = await createHttpClient({ fetch: stub.fetch }).request({
      url: 'http://users/cards',
      correlationId: 'corr-12345678',
    });
    expect(result).toEqual({ ok: true, value: { status: 200, body: { ok: true } } });
    expect(stub.calls[0]?.headers['x-correlation-id']).toBe('corr-12345678');
  });

  it('normalises header names so caller casing cannot duplicate the correlation id', async () => {
    const stub = fakeFetch(() => jsonResponse(200, {}));
    await createHttpClient({ fetch: stub.fetch }).request({
      url: 'http://x',
      headers: { 'X-Correlation-Id': 'spoofed-1', Authorization: 'Bearer t' },
      correlationId: 'corr-12345678',
    });
    expect(stub.calls[0]?.headers).toEqual({ authorization: 'Bearer t', 'x-correlation-id': 'corr-12345678' });
  });

  it('times out at 2s by default', async () => {
    vi.useFakeTimers();
    const pending = createHttpClient({ fetch: neverResolvesUntilAborted }).request({
      url: 'http://slow',
      method: 'POST',
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout', detail: 'no response within 2000ms' } });
  });

  it('returns 4xx as a response, 5xx as an error', async () => {
    const client = (status: number) =>
      createHttpClient({ fetch: fakeFetch(() => jsonResponse(status, {})).fetch }).request({
        url: 'http://x',
        method: 'POST',
      });
    expect((await client(404)).ok).toBe(true);
    expect(await client(503)).toMatchObject({ ok: false, error: { kind: 'server_error' } });
  });

  it('maps a network failure to an error', async () => {
    const fetch: Fetch = async () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await createHttpClient({ fetch }).request({ url: 'http://x', method: 'POST' })).toEqual({
      ok: false,
      error: { kind: 'network', detail: 'ECONNREFUSED' },
    });
  });

  it('retries a failed GET exactly once', async () => {
    const responses = [503, 200];
    const stub = fakeFetch(() => jsonResponse(responses.shift() ?? 500, {}));
    expect((await createHttpClient({ fetch: stub.fetch }).request({ url: 'http://x' })).ok).toBe(true);
    expect(stub.calls).toHaveLength(2);

    const alwaysDown = fakeFetch(() => jsonResponse(500, {}));
    expect((await createHttpClient({ fetch: alwaysDown.fetch }).request({ url: 'http://x' })).ok).toBe(false);
    expect(alwaysDown.calls).toHaveLength(2);
  });

  it('never retries a POST', async () => {
    const stub = fakeFetch(() => jsonResponse(500, {}));
    await createHttpClient({ fetch: stub.fetch }).request({ url: 'http://x', method: 'POST' });
    expect(stub.calls).toHaveLength(1);
  });
});
