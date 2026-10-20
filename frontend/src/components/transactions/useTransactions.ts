import { useInfiniteQuery } from '@tanstack/react-query';
import { useApi } from '../../api/ApiProvider';
import type { operations } from '../../api/generated/transactions';
import type { TransactionFilter } from './types';

type TransactionsPage = operations['listMyTransactions']['responses'][200]['content']['application/json'];

export const useTransactions = (filter: TransactionFilter) => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['transactions', filter],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<TransactionsPage> => {
      const query = pageParam === null ? filter : { ...filter, cursor: pageParam };
      const { data, response } = await api.GET('/transactions', { params: { query }, signal });
      // TanStack Query needs a rejection to enter its error state; the body is not echoed.
      if (!data) throw new Error(`GET /transactions failed with ${response.status}`);
      return data;
    },
    getNextPageParam: (page) => page.nextCursor,
  });
};
