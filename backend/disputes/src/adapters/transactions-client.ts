import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@cd/dispute-domain';
import { ok } from '@cd/shared/fp';
import { z } from 'zod';
import type { Transaction } from '../core/types.ts';
import type { FindTransaction } from '../use-cases/ports.ts';
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

const lookupResponse = z.object({ items: z.array(rawTransaction).max(100) });

export const createTransactionsClient = (
  deps: ServiceClientDeps,
): { readonly findTransaction: FindTransaction } => {
  const get = getJson(deps);
  return {
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
