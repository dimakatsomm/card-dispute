import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/ApiProvider';
import type { components } from '../../api/generated/users';

export type Me = components['schemas']['Me'];
export type Account = components['schemas']['Account'];
export type Card = Account['cards'][number];

const ME_STALE_MS = 5 * 60 * 1000;

export const useMe = () => {
  const api = useApi();
  return useQuery({
    queryKey: ['me'],
    queryFn: async ({ signal }): Promise<Me> => {
      const { data, response } = await api.GET('/me', { signal });
      // TanStack Query needs a rejection to enter its error state; the body is not echoed.
      if (!data) throw new Error(`GET /me failed with ${response.status}`);
      return data;
    },
    // Account and card screens read cards from this cached response instead of calling /me again (flow step 3).
    staleTime: ME_STALE_MS,
  });
};

export const findAccount = (me: Me, accountId: string): Account | undefined =>
  me.accounts.find((account) => account.accountId === accountId);

export const findCard = (me: Me, cardId: string): Card | undefined =>
  me.accounts.flatMap((account) => account.cards).find((card) => card.cardId === cardId);
