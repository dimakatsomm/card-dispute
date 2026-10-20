import { ok, type Result } from '@cd/shared/fp';
import type { LookupQuery, Transaction } from '../core/transaction.ts';

export type LookupTransactionsDeps = {
  readonly lookup: (query: LookupQuery) => Promise<ReadonlyArray<Transaction>>;
};

// ADR-025: the raw lookup takes no outbound deps, so it cannot call back into disputes.
export const lookupTransactions =
  (deps: LookupTransactionsDeps) =>
  async (query: LookupQuery): Promise<Result<ReadonlyArray<Transaction>, never>> =>
    ok(await deps.lookup({ ...query, transactionIds: [...new Set(query.transactionIds)] }));
