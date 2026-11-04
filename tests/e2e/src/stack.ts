import { createHash, randomBytes } from 'node:crypto';

export const URLS = {
  issuer: process.env['E2E_ISSUER_URL'] ?? 'http://localhost:55900',
  users: process.env['E2E_USERS_URL'] ?? 'http://localhost:58081',
  transactions: process.env['E2E_TRANSACTIONS_URL'] ?? 'http://localhost:58082',
  disputes: process.env['E2E_DISPUTES_URL'] ?? 'http://localhost:58083',
  frontend: process.env['E2E_FRONTEND_URL'] ?? 'http://localhost:5173',
} as const;

const SPA_REDIRECT = 'http://localhost:5173/callback';
const AGENT_REDIRECT = 'http://localhost:5173/agent/callback';
const SERVICE_SECRET = process.env['MOCK_ISSUER_CLIENT_SECRET'] ?? 'local-dev-client-secret';

export type UserKey = 'A' | 'B';

// E is the ACTIVE seeded agent, F the DISABLED one (local/README.md).
export type AgentKey = 'E' | 'F';

export type Reply<T = Json> = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
};

// Responses are untrusted JSON; tests assert on the shape instead of re-declaring every body type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

const parse = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export const call = async <T = Json>(
  method: string,
  url: string,
  options: { readonly token?: string; readonly body?: unknown; readonly headers?: Record<string, string> } = {},
): Promise<Reply<T>> => {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: 'manual',
  });
  return { status: res.status, headers: res.headers, body: (await parse(res)) as T };
};

const pkceToken = async (clientId: string, redirectUri: string, loginAs: string): Promise<string> => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/oauth2/authorize', URLS.issuer);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_as: loginAs,
  }).toString();
  const redirect = await fetch(authorize, { redirect: 'manual' });
  const location = redirect.headers.get('location');
  const code = location === null ? null : new URL(location).searchParams.get('code');
  if (code === null) throw new Error(`authorize for ${loginAs} on ${clientId} returned no code (status ${redirect.status})`);
  const res = await fetch(new URL('/oauth2/token', URLS.issuer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const token = (await parse(res)) as { access_token?: string };
  if (typeof token.access_token !== 'string') {
    throw new Error(`token exchange for ${loginAs} on ${clientId} failed (status ${res.status})`);
  }
  return token.access_token;
};

export const userToken = (user: UserKey): Promise<string> => pkceToken('spa', SPA_REDIRECT, user);

export const agentToken = (agent: AgentKey): Promise<string> => pkceToken('backoffice', AGENT_REDIRECT, agent);

export const serviceToken = async (clientId: string): Promise<string> => {
  const res = await fetch(new URL('/oauth2/token', URLS.issuer), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${SERVICE_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const token = (await parse(res)) as { access_token?: string };
  if (typeof token.access_token !== 'string') throw new Error(`client_credentials for ${clientId} failed (status ${res.status})`);
  return token.access_token;
};

export type Txn = {
  readonly transactionId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly status: string;
  readonly type: string;
  readonly postedAt: string | null;
  readonly dispute: { readonly disputeId: string; readonly status: string } | null;
  readonly disputable: { readonly allowed: boolean; readonly reason?: string };
};

export const listTransactions = async (token: string, query: Record<string, string> = {}): Promise<readonly Txn[]> => {
  const items: Txn[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '100', ...query, ...(cursor !== null ? { cursor } : {}) });
    const page: Reply<{ items: Txn[]; nextCursor: string | null }> = await call(
      'GET',
      `${URLS.transactions}/transactions?${params}`,
      { token },
    );
    if (page.status !== 200) throw new Error(`GET /transactions returned ${page.status}`);
    items.push(...page.body.items);
    cursor = page.body.nextCursor;
  } while (cursor !== null);
  return items;
};

// Disputes are never deleted, so each run uses up rows: take the first disputable one on a live card.
export const freshDisputable = async (token: string): Promise<Txn> => {
  const me = (await call('GET', `${URLS.users}/me`, { token })).body;
  const cards: Json[] = me['accounts'].flatMap((account: Json) => account['cards']);
  for (const card of cards.filter((c) => c['expired'] === false && c['status'] === 'ACTIVE')) {
    const row = (await listTransactions(token, { cardId: card['cardId'] })).find((item) => item.disputable.allowed);
    if (row !== undefined) return row;
  }
  throw new Error('no disputable transaction left on a live card; reseed');
};
