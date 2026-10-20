import type { Fetch } from '../src/http-client.ts';

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type RecordedCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
};

export type FakeFetch = { readonly fetch: Fetch; readonly calls: RecordedCall[] };

export const fakeFetch = (respond: (call: RecordedCall) => Response | Promise<Response>): FakeFetch => {
  const calls: RecordedCall[] = [];
  const fetch: Fetch = async (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
};

export const AUTH_ID = '01990000-0000-7000-8000-0000000000a1';
export const USER_ID = '01990000-0000-7000-8000-0000000000b1';

export const userPrincipal = (exp: number) => ({
  valid: true,
  principalType: 'user',
  authId: AUTH_ID,
  userId: USER_ID,
  scopes: [],
  exp,
});

export const invalidResult = (reason: string) => ({ valid: false, principalType: 'none', reason });

export const servicePrincipal = (exp: number, scopes: readonly string[]) => ({
  valid: true,
  principalType: 'service',
  clientId: 'svc-transactions',
  scopes,
  exp,
});
