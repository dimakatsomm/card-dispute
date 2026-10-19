import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client';

const ApiContext = createContext<ApiClient | null>(null);

export const ApiProvider = ({ client, children }: { readonly client: ApiClient; readonly children: ReactNode }) => (
  <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
);

export const useApi = (): ApiClient => {
  const client = useContext(ApiContext);
  if (!client) throw new Error('useApi must be used inside <ApiProvider>');
  return client;
};
