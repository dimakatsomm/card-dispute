import { describe, expect, it } from 'vitest';
import { createApiClient } from './client';

const cardId = '0192f0c1-0000-7000-8000-0000000000c1';

const setup = (token: string | null) => {
  const requests: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    requests.push(request);
    return new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createApiClient({
    apiBase: '/api',
    origin: 'https://disputes.example',
    getAccessToken: async () => token,
    fetch,
  });
  return { client, requests };
};

describe('api client', () => {
  it('sends the bearer token on same-origin /api requests', async () => {
    const { client, requests } = setup('token-123');

    await client.GET('/transactions', { params: { query: { cardId } } });

    expect(requests[0]?.url).toBe(`https://disputes.example/api/transactions?cardId=${cardId}`);
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer token-123');
  });

  it('never sends the bearer token to another origin', async () => {
    const { client, requests } = setup('token-123');

    await client.GET('/disputes', { baseUrl: 'https://evil.example/api' });

    expect(requests[0]?.url).toBe('https://evil.example/api/disputes');
    expect(requests[0]?.headers.has('Authorization')).toBe(false);
  });

  it('sends no Authorization header when there is no session', async () => {
    const { client, requests } = setup(null);

    await client.GET('/disputes');

    expect(requests[0]?.headers.has('Authorization')).toBe(false);
  });
});
