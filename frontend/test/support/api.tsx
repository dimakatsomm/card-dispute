import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { ApiProvider } from '../../src/api/ApiProvider';
import { createApiClient } from '../../src/api/client';

export type Handler = (request: Request) => Response | Promise<Response>;

export const json = (
  body: unknown,
  init: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): Response => {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...init.headers },
  });
};

export const problem = (status: number, code = 'UNAVAILABLE'): Response =>
  json({ type: 'about:blank', title: code, status, code, correlationId: 'test-correlation' }, { status });

export const pathOf = (request: Request): string => new URL(request.url).pathname.replace(/^\/api/, '');

export const urlsTo = (requests: ReadonlyArray<Request>, path: string): ReadonlyArray<URL> =>
  requests.filter((request) => pathOf(request) === path).map((request) => new URL(request.url));

export const renderWithApi = (options: {
  readonly routes: RouteObject[];
  readonly url: string;
  readonly handler: Handler;
}) => {
  const requests: Request[] = [];
  const api = createApiClient({
    apiBase: '/api',
    origin: 'https://app.test',
    getAccessToken: async () => 'test-token',
    fetch: async (request) => {
      requests.push(request.clone());
      return options.handler(request);
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(options.routes, { initialEntries: [options.url] });
  const view = render(
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...view, requests, router };
};
