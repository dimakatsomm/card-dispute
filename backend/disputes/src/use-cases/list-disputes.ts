import type { DisputeStatus, ReasonCode } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { decodeCursor, encodeCursor, type CursorError } from '../core/cursor.ts';
import { toTransactionRef } from '../core/dispute.ts';
import { lastEventOf, type LastEvent } from '../core/timeline.ts';
import type { Transaction, TransactionRef } from '../core/types.ts';
import type {
  DisputeSummaryRecord,
  FindTransactions,
  ListDisputePage,
  ListDisputeTransactionIds,
  TransactionFilter,
  UpstreamError,
} from './ports.ts';

export type ListDisputesDeps = {
  readonly listTransactionIds: ListDisputeTransactionIds;
  readonly listPage: ListDisputePage;
  readonly findTransactions: FindTransactions;
};

export type ListDisputesInput = {
  readonly userId: string;
  readonly statuses: ReadonlyArray<DisputeStatus>;
  readonly filter: TransactionFilter;
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly correlationId: string;
};

export type DisputeSummary = {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly status: DisputeStatus;
  readonly reasonCode: ReasonCode;
  readonly transaction: TransactionRef | null;
  readonly lastEvent: LastEvent;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DisputePage = {
  readonly items: ReadonlyArray<DisputeSummary>;
  readonly nextCursor: string | null;
};

export type ListDisputesError = CursorError | UpstreamError;

type TransactionsById = ReadonlyMap<string, Transaction>;

const EMPTY: DisputePage = { items: [], nextCursor: null };

const toSummary = (row: DisputeSummaryRecord, transactions: TransactionsById): DisputeSummary => {
  const txn = transactions.get(row.dispute.transactionId);
  return {
    disputeId: row.dispute.disputeId,
    transactionId: row.dispute.transactionId,
    status: row.dispute.status,
    reasonCode: row.dispute.reasonCode,
    transaction: txn === undefined ? null : toTransactionRef(txn),
    lastEvent: lastEventOf(row.latest, row.dispute.createdAt),
    createdAt: row.dispute.createdAt.toISOString(),
    updatedAt: row.dispute.updatedAt.toISOString(),
  };
};

// The repository is asked for limit + 1 rows; the extra row only signals that another page exists.
const toPage = (
  rows: ReadonlyArray<DisputeSummaryRecord>,
  limit: number,
  transactions: TransactionsById,
): DisputePage => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map((row) => toSummary(row, transactions)),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.position) : null,
  };
};

const byId = (transactions: ReadonlyArray<Transaction>): TransactionsById =>
  new Map(transactions.map((t) => [t.transactionId, t]));

const hasFilter = (filter: TransactionFilter): boolean =>
  filter.accountId !== undefined || filter.cardId !== undefined;

export const listDisputes =
  (deps: ListDisputesDeps) =>
  async (input: ListDisputesInput): Promise<Result<DisputePage, ListDisputesError>> => {
    const after = input.cursor === undefined ? ok(null) : decodeCursor(input.cursor);
    if (!after.ok) return after;

    const fetchTransactions = (ids: ReadonlyArray<string>, filter: TransactionFilter) =>
      deps
        .findTransactions(input.userId, ids, filter, input.correlationId)
        .catch(() => err('UPSTREAM_UNAVAILABLE' as const));

    const page = (transactionIds: ReadonlyArray<string> | null) =>
      deps.listPage({
        userId: input.userId,
        statuses: input.statuses,
        transactionIds,
        after: after.value,
        limit: input.limit + 1,
      });

    // The dispute stores only transaction_id, so an account/card filter is answered by transactions (ADR-025).
    if (hasFilter(input.filter)) {
      const ids = await deps.listTransactionIds(input.userId, input.statuses);
      if (ids.length === 0) return ok(EMPTY);
      const matching = await fetchTransactions(ids, input.filter);
      if (!matching.ok) return matching;
      if (matching.value.length === 0) return ok(EMPTY);
      const transactions = byId(matching.value);
      return ok(toPage(await page([...transactions.keys()]), input.limit, transactions));
    }

    const rows = await page(null);
    const ids = rows.slice(0, input.limit).map((r) => r.dispute.transactionId);
    if (ids.length === 0) return ok(EMPTY);
    // Unfiltered lists degrade to transaction: null rather than failing (docs/02).
    const found = await fetchTransactions(ids, {});
    return ok(toPage(rows, input.limit, found.ok ? byId(found.value) : new Map()));
  };
