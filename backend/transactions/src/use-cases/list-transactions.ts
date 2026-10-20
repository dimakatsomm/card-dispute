import { err, ok, type Result } from '@cd/shared/fp';
import { decodeCursor, toPage, type CursorError, type Page } from '../core/cursor.ts';
import {
  enrich,
  type CardRef,
  type DisputeRef,
  type EnrichedTransaction,
  type UpstreamError,
} from '../core/disputable.ts';
import type { ListFilter, PageQuery, Transaction } from '../core/transaction.ts';

export type ListTransactionsDeps = {
  readonly listPage: (query: PageQuery) => Promise<ReadonlyArray<Transaction>>;
  readonly dbNow: () => Promise<Date>;
  readonly fetchCards: (
    userId: string,
    correlationId: string,
  ) => Promise<Result<ReadonlyArray<CardRef>, UpstreamError>>;
  readonly fetchDisputes: (
    userId: string,
    transactionIds: ReadonlyArray<string>,
    correlationId: string,
  ) => Promise<Result<ReadonlyArray<DisputeRef>, UpstreamError>>;
};

export type ListTransactionsInput = {
  readonly userId: string;
  readonly filter: ListFilter;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly correlationId: string;
};

export type ListTransactionsOutput = Page<EnrichedTransaction> & {
  readonly degraded: ReadonlyArray<UpstreamError>;
};

export type ListTransactionsError = CursorError;

export const listTransactions =
  (deps: ListTransactionsDeps) =>
  async (input: ListTransactionsInput): Promise<Result<ListTransactionsOutput, ListTransactionsError>> => {
    const after = input.cursor === undefined ? ok(null) : decodeCursor(input.cursor);
    if (!after.ok) return err(after.error);

    const rows = await deps.listPage({
      userId: input.userId,
      filter: input.filter,
      after: after.value,
      limit: input.limit + 1,
    });
    const page = toPage(rows, input.limit);
    if (page.items.length === 0) return ok({ items: [], nextCursor: page.nextCursor, degraded: [] });

    const [cards, disputes, now] = await Promise.all([
      deps.fetchCards(input.userId, input.correlationId),
      deps.fetchDisputes(
        input.userId,
        page.items.map((t) => t.transactionId),
        input.correlationId,
      ),
      deps.dbNow(),
    ]);
    const degraded = [cards, disputes].flatMap((r) => (r.ok ? [] : [r.error]));
    const enrichment = cards.ok && disputes.ok ? { cards: cards.value, disputes: disputes.value } : null;
    return ok({ items: enrich(page.items, enrichment, now), nextCursor: page.nextCursor, degraded });
  };
