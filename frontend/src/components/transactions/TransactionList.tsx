import { useCallback, useEffect, useRef } from 'react';
import { Button, Empty, Loading, cardClass, cx } from '../ui';
import { LoadError } from './LoadError';
import { headCellClass, type Column } from './tableClasses';
import { TransactionItem } from './TransactionItem';
import type { TransactionFilter } from './types';
import { useTransactions } from './useTransactions';

// Where IntersectionObserver is missing, the "Load more" button remains the (keyboard-accessible) way to page.
const useLoadOnScroll = (enabled: boolean, load: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, load]);
  return ref;
};

type TransactionListProps = { readonly filter: TransactionFilter; readonly caption: string };

const columns: ReadonlyArray<{ readonly column: Column; readonly label: string }> = [
  { column: 'date', label: 'Date' },
  { column: 'merchant', label: 'Merchant' },
  { column: 'type', label: 'Type' },
  { column: 'amount', label: 'Amount' },
  { column: 'status', label: 'Status' },
  { column: 'dispute', label: 'Dispute' },
];

export const TransactionList = ({ filter, caption }: TransactionListProps) => {
  const query = useTransactions(filter);
  const { fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError } = query;
  // By default fetchNextPage cancels a running refetch, which would leave the earlier pages stale.
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const sentinel = useLoadOnScroll(hasNextPage && !isFetching && !isFetchNextPageError, loadMore);

  if (query.isPending) return <Loading>Loading transactions…</Loading>;
  if (query.isError && !query.data) {
    return <LoadError message="We couldn't load your transactions." onRetry={() => void query.refetch()} />;
  }

  const rows = query.data.pages.flatMap((page) => page.items);
  if (rows.length === 0) return <Empty>No transactions to show.</Empty>;

  return (
    <div className="space-y-4">
      <div className={cx(cardClass, 'overflow-x-auto')}>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-line bg-zinc-50/80">
            <tr>
              {columns.map(({ column, label }) => (
                <th key={column} scope="col" className={headCellClass(column)}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((row) => (
              <TransactionItem key={row.transactionId} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      {isFetchNextPageError ? <LoadError message="We couldn't load more transactions." onRetry={loadMore} /> : null}
      {hasNextPage && !isFetchNextPageError ? (
        <div ref={sentinel} className="flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={isFetching}>
            {isFetchingNextPage ? 'Loading more…' : 'Load more transactions'}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
