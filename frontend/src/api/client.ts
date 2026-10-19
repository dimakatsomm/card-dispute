import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths as DisputesPaths } from './generated/disputes';
import type { paths as TransactionsPaths } from './generated/transactions';
import type { paths as UsersPaths } from './generated/users';

export type ApiPaths = UsersPaths & TransactionsPaths & DisputesPaths;

export type ApiClient = Client<ApiPaths>;

export type ApiClientDeps = {
  readonly apiBase: string;
  readonly origin: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly fetch?: (request: Request) => Promise<Response>;
};

// The bearer goes only to the API origin, even if a caller overrides baseUrl or passes an absolute URL.
export const authMiddleware = (
  apiOrigin: string,
  getAccessToken: () => Promise<string | null>,
): Middleware => ({
  onRequest: async ({ request }) => {
    if (new URL(request.url).origin !== apiOrigin) return undefined;
    const token = await getAccessToken();
    if (!token) return undefined;
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return new Request(request, { headers });
  },
});

export const createApiClient = (deps: ApiClientDeps): ApiClient => {
  const baseUrl = new URL(deps.apiBase, deps.origin);
  const client = createClient<ApiPaths>({
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  client.use(authMiddleware(baseUrl.origin, deps.getAccessToken));
  return client;
};
