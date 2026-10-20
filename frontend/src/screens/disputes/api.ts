import type { ApiClient } from '../../api/client';
import type { components as DisputeSchemas } from '../../api/generated/disputes';
import type { components as UserSchemas } from '../../api/generated/users';
import { err, ok, type Result } from '../../app/result';
import type { DisputeStatus } from './labels';

export type DisputeSummary = DisputeSchemas['schemas']['DisputeSummary'];
export type Account = UserSchemas['schemas']['Account'];

export type DisputeFilters = {
  readonly status: ReadonlyArray<DisputeStatus>;
  readonly accountId: string | undefined;
  readonly cardId: string | undefined;
};

export type DisputesPage = {
  readonly items: ReadonlyArray<DisputeSummary>;
  readonly nextCursor: string | null;
};

export type ListError = 'FILTER_UNAVAILABLE' | 'BAD_FILTER' | 'FAILED';

export const listDisputes =
  (api: ApiClient) =>
  async (input: { readonly filters: DisputeFilters; readonly cursor: string | undefined }): Promise<
    Result<DisputesPage, ListError>
  > => {
    const { filters, cursor } = input;
    const { data, response } = await api.GET('/disputes', {
      params: {
        query: {
          ...(filters.status.length > 0 ? { status: [...filters.status] } : {}),
          ...(filters.accountId ? { accountId: filters.accountId } : {}),
          ...(filters.cardId ? { cardId: filters.cardId } : {}),
          ...(cursor ? { cursor } : {}),
        },
      },
    });
    if (data) return ok(data);
    if (response.status === 503) return err('FILTER_UNAVAILABLE');
    if (response.status === 400) return err('BAD_FILTER');
    return err('FAILED');
  };
