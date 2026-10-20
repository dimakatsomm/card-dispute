import { zLookupTransactionsResponse } from '@cd/contracts/transactions.service';
import { ok, type Result } from '@cd/shared/fp';
import type { Transaction } from '../core/types.ts';
import type {
  FindTransaction,
  FindTransactions,
  TransactionFilter,
  UpstreamError,
} from '../use-cases/ports.ts';
import { getJson, type ServiceClientDeps } from './service-client.ts';

export const LOOKUP_MAX_IDS = 100;

const chunk = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export const createTransactionsClient = (
  deps: ServiceClientDeps,
): { readonly findTransaction: FindTransaction; readonly findTransactions: FindTransactions } => {
  const get = getJson(deps);

  const lookupChunk = async (
    userId: string,
    ids: ReadonlyArray<string>,
    filter: TransactionFilter,
    correlationId: string,
  ): Promise<Result<ReadonlyArray<Transaction>, UpstreamError>> => {
    const res = await get(
      '/transactions',
      {
        userId,
        transactionIds: ids.join(','),
        ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
        ...(filter.cardId === undefined ? {} : { cardId: filter.cardId }),
      },
      zLookupTransactionsResponse,
      correlationId,
    );
    if (!res.ok) return res;
    // Defence in depth: a row we did not ask for, or outside the filter, never reaches this user's response.
    const asked = new Set(ids);
    return ok(
      res.value.items.filter(
        (t) =>
          asked.has(t.transactionId) &&
          (filter.accountId === undefined || t.accountId === filter.accountId) &&
          (filter.cardId === undefined || t.cardId === filter.cardId),
      ),
    );
  };

  return {
    // Chunks run in parallel, so the whole lookup stays inside one per-call deadline rather than one per chunk.
    findTransactions: async (userId, transactionIds, filter, correlationId) => {
      const results = await Promise.all(
        chunk([...new Set(transactionIds)], LOOKUP_MAX_IDS).map((ids) =>
          lookupChunk(userId, ids, filter, correlationId),
        ),
      );
      const failed = results.find((r) => !r.ok);
      return failed ?? ok(results.flatMap((r) => (r.ok ? r.value : [])));
    },
    findTransaction: async (userId, transactionId, correlationId) => {
      const res = await get(
        '/transactions',
        { userId, transactionIds: transactionId },
        zLookupTransactionsResponse,
        correlationId,
      );
      if (!res.ok) return res;
      const match: Transaction | undefined = res.value.items.find((t) => t.transactionId === transactionId);
      return ok(match ?? null);
    },
  };
};
