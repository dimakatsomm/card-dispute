import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { ApiProvider } from '../api/ApiProvider';
import type { ApiClient } from '../api/client';
import type { Auth } from '../auth/auth';
import { AuthProvider } from '../auth/AuthProvider';
import { createAppRouter } from './router';

export type AppProps = {
  readonly auth: Auth;
  readonly api: ApiClient;
  readonly callbackPath: string;
};

export const App = ({ auth, api, callbackPath }: AppProps) => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  const [router] = useState(() => createAppRouter(callbackPath));
  return (
    <AuthProvider auth={auth}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </AuthProvider>
  );
};

export const ConfigErrorScreen = () => (
  <main role="alert">
    <h1>Service unavailable</h1>
    <p>The application is not configured correctly. Please try again later.</p>
  </main>
);
