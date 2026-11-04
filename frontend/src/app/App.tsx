import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { ApiProvider } from '../api/ApiProvider';
import type { ApiClient } from '../api/client';
import type { Auth } from '../auth/auth';
import { AgentAreaProvider, AuthProvider, type AgentArea } from '../auth/AuthProvider';
import { createAppRouter } from './router';

export type AppProps = {
  readonly auth: Auth;
  readonly api: ApiClient;
  readonly callbackPath: string;
  readonly agent: (AgentArea & { readonly callbackPath: string }) | null;
};

export const App = ({ auth, api, callbackPath, agent }: AppProps) => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  const [router] = useState(() => createAppRouter({ callbackPath, agentCallbackPath: agent?.callbackPath ?? null }));
  return (
    <AuthProvider auth={auth}>
      <AgentAreaProvider agent={agent}>
        <ApiProvider client={api}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ApiProvider>
      </AgentAreaProvider>
    </AuthProvider>
  );
};

export const ConfigErrorScreen = () => (
  <main role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-2 px-6">
    <h1 className="text-2xl font-semibold tracking-tight">Service unavailable</h1>
    <p className="text-muted">The application is not configured correctly. Please try again later.</p>
  </main>
);
