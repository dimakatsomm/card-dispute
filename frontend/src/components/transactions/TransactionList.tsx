import { useCallback, useEffect, useRef } from 'react';
import { LoadError } from './LoadError';
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

export const TransactionList = ({ filter, caption }: TransactionListProps) => {
  const query = useTransactions(filter);
  const { fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError } = query;
  // By default fetchNextPage cancels a running refetch, which would leave the earlier pages stale.
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const sentinel = useLoadOnScroll(hasNextPage && !isFetching && !isFetchNextPageError, loadMore);

  if (query.isPending) return <p role="status">Loading transactions…</p>;
  if (query.isError && !query.data) {
    return <LoadError message="We couldn't load your transactions." onRetry={() => void query.refetch()} />;
  }

  const rows = query.data.pages.flatMap((page) => page.items);
  if (rows.length === 0) return <p>No transactions to show.</p>;

  return (
    <>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Merchant</th>
            <th scope="col">Type</th>
            <th scope="col">Amount</th>
            <th scope="col">Status</th>
            <th scope="col">Dispute</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <TransactionItem key={row.transactionId} row={row} />
          ))}
        </tbody>
      </table>
      {isFetchNextPageError ? <LoadError message="We couldn't load more transactions." onRetry={loadMore} /> : null}
      {hasNextPage && !isFetchNextPageError ? (
        <div ref={sentinel}>
          <button type="button" onClick={loadMore} disabled={isFetching}>
            {isFetchingNextPage ? 'Loading more…' : 'Load more transactions'}
          </button>
        </div>
      ) : null}
    </>
  );
};
