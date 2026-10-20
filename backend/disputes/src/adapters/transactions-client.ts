import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@cd/dispute-domain';
import { ok, type Result } from '@cd/shared/fp';
import { z } from 'zod';
import type { Transaction } from '../core/types.ts';
import type {
  FindTransaction,
  FindTransactions,
  TransactionFilter,
  UpstreamError,
} from '../use-cases/ports.ts';
import { getJson, type ServiceClientDeps } from './service-client.ts';

const timestamp = z.iso.datetime({ offset: true });

const rawTransaction = z.object({
  transactionId: z.uuid(),
  accountId: z.uuid(),
  cardId: z.uuid(),
  amount: z.string().regex(/^[0-9]{1,10}\.[0-9]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  merchantName: z.string(),
  type: z.enum(TRANSACTION_TYPES),
  status: z.enum(TRANSACTION_STATUSES),
  transactionAt: timestamp,
  postedAt: timestamp.nullable(),
});

export const LOOKUP_MAX_IDS = 100;

const lookupResponse = z.object({ items: z.array(rawTransaction).max(LOOKUP_MAX_IDS) });

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
      lookupResponse,
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
        lookupResponse,
        correlationId,
      );
      if (!res.ok) return res;
      const match: Transaction | undefined = res.value.items.find((t) => t.transactionId === transactionId);
      return ok(match ?? null);
    },
  };
};
