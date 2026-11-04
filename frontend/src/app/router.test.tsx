import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { json, pathOf } from '../../test/support/api';
import { ApiProvider } from '../api/ApiProvider';
import { createApiClient } from '../api/client';
import type { Auth, AuthUser } from '../auth/auth';
import { AgentAreaProvider, AuthProvider } from '../auth/AuthProvider';
import { appRoutes } from './router';

const fakeAuth = (user: AuthUser | null) => {
  const signIn = vi.fn<Auth['signIn']>(async () => undefined);
  const auth: Auth = {
    signIn,
    completeSignIn: async () => ({ ok: true, value: '/' }),
    signOut: async () => undefined,
    getAccessToken: async () => (user ? `token-${user.subject}` : null),
    currentUser: async () => user,
    onChange: () => () => undefined,
  };
  return { auth, signIn };
};

const customer: AuthUser = { subject: 'customer-a', groups: [] };
const agentUser: AuthUser = { subject: 'agent-e', groups: ['agents'] };

const renderApp = (url: string, sessions: { readonly customer: AuthUser | null; readonly agent: AuthUser | null }) => {
  const customerAuth = fakeAuth(sessions.customer);
  const agentAuth = fakeAuth(sessions.agent);
  const requests: Array<{ readonly path: string; readonly token: string | null }> = [];
  const apiFor = (auth: Auth) =>
    createApiClient({
      apiBase: '/api',
      origin: 'https://app.test',
      getAccessToken: auth.getAccessToken,
      fetch: async (request) => {
        requests.push({ path: pathOf(request), token: request.headers.get('Authorization') });
        return pathOf(request) === '/agent/review-queue'
          ? json({ items: [], nextCursor: null })
          : json({ items: [], nextCursor: null, accounts: [] });
      },
    });
  const router = createMemoryRouter(appRoutes({ callbackPath: '/callback', agentCallbackPath: '/agent/callback' }), {
    initialEntries: [url],
  });
  render(
    <AuthProvider auth={customerAuth.auth}>
      <AgentAreaProvider agent={{ auth: agentAuth.auth, api: apiFor(agentAuth.auth) }}>
        <ApiProvider client={apiFor(customerAuth.auth)}>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ApiProvider>
      </AgentAreaProvider>
    </AuthProvider>,
  );
  return { router, requests, customerSignIn: customerAuth.signIn, agentSignIn: agentAuth.signIn };
};

describe('router: customer and agent areas never mix (the API stays authoritative)', () => {
  it.each(['/agent', '/agent/disputes/0192f0c1-0000-7000-8000-0000000000t1'])(
    'a signed-in customer cannot reach %s',
    async (url) => {
      const { requests, agentSignIn } = renderApp(url, { customer, agent: null });

      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Agent sign-in' })).toBeNull();
      expect(agentSignIn).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    },
  );

  it.each(['/', '/disputes', '/disputes/0192f0c1-0000-7000-8000-0000000000t1', '/accounts/a1'])(
    'an agent opening %s is sent to the review queue and never starts a customer sign-in',
    async (url) => {
      const { router, requests, customerSignIn } = renderApp(url, { customer: null, agent: agentUser });

      expect(await screen.findByRole('heading', { name: 'Review queue' })).toBeTruthy();
      expect(router.state.location.pathname).toBe('/agent');
      expect(customerSignIn).not.toHaveBeenCalled();
      expect(requests).toEqual([{ path: '/agent/review-queue', token: 'Bearer token-agent-e' }]);
    },
  );

  it('the agent area offers its own sign-in and never the customer one', async () => {
    const { agentSignIn, customerSignIn } = renderApp('/agent', { customer: null, agent: null });

    await userEvent.click(await screen.findByRole('button', { name: 'Agent sign-in' }));

    expect(agentSignIn).toHaveBeenCalledExactlyOnceWith('/agent');
    expect(customerSignIn).not.toHaveBeenCalled();
  });

  it('a back-office sign-in without the agents group gets no agent screens', async () => {
    const { requests } = renderApp('/agent', { customer: null, agent: { subject: 'customer-a', groups: [] } });

    expect((await screen.findByRole('alert')).textContent).toContain('This account is not a back-office agent.');
    expect(requests).toEqual([]);
  });
});
