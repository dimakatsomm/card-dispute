import { queryOf } from '@cd/contracts/query';
import { zListMyTransactionsQuery } from '@cd/contracts/transactions.public';
import { zLookupTransactionsQuery } from '@cd/contracts/transactions.service';
import { lteMoney } from '@cd/shared';

// Calendar validity, year >= 0001 and the ±14:00 offset are already enforced by the generated Timestamp.
export const listQuerySchema = queryOf(zListMyTransactionsQuery)
  .refine((q) => q.from === undefined || q.to === undefined || Date.parse(q.from) < Date.parse(q.to), {
    path: ['to'],
    message: 'must be after from',
  })
  .refine(
    (q) => {
      if (q.minAmount === undefined || q.maxAmount === undefined) return true;
      const lte = lteMoney(q.minAmount, q.maxAmount);
      return lte.ok && lte.value;
    },
    { path: ['maxAmount'], message: 'must be at least minAmount' },
  );

export const lookupQuerySchema = queryOf(zLookupTransactionsQuery, { csv: ['transactionIds'] });
