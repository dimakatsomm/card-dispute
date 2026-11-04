import { useInfiniteQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { agentRoutes } from '../../app/routes';
import { LoadError } from '../../components/transactions/LoadError';
import {
  Badge,
  Button,
  Empty,
  Field,
  Label,
  Loading,
  PageHeader,
  Select,
  cardClass,
  cx,
  disputeStatusTone,
  linkClass,
} from '../../components/ui';
import { formatDateTime, reasonLabel } from '../disputes/labels';
import { listReviewQueue, type QueueItem } from './api';
import { QUEUE_STATUSES, agentStatusLabel, isQueueStatus } from './labels';

const cellClass = 'px-4 py-3 text-left align-top';
const headCellClass = cx(cellClass, 'text-xs font-medium tracking-wide text-muted uppercase');

const QueueRow = ({ item }: { readonly item: QueueItem }) => (
  <tr className="border-t border-line">
    <td className={cellClass}>
      <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
    </td>
    <td className={cellClass}>{reasonLabel[item.reasonCode]}</td>
    <td className={cellClass}>
      <Badge tone={disputeStatusTone[item.status]}>{agentStatusLabel[item.status]}</Badge>
    </td>
    <td className={cellClass}>{item.pickedUpBy ?? <span className="text-muted">Nobody yet</span>}</td>
    <td className={cellClass}>
      <Link
        to={agentRoutes.dispute(item.transactionId)}
        className={linkClass}
        aria-label={`Open dispute ${item.disputeId}`}
      >
        Open
      </Link>
    </td>
  </tr>
);

export const AgentQueueScreen = () => {
  const api = useApi();
  const statusId = useId();
  const [params, setParams] = useSearchParams();
  const requested = params.get('status');
  const status = isQueueStatus(requested) ? requested : null;

  const queue = useInfiniteQuery({
    queryKey: ['agent', 'queue', status],
    queryFn: ({ pageParam }) => listReviewQueue(api)({ status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.ok ? (last.value.nextCursor ?? undefined) : undefined),
  });

  const pages = queue.data?.pages ?? [];
  const items = pages.flatMap((page) => (page.ok ? page.value.items : []));
  const failed = queue.isError || pages.some((page) => !page.ok);

  return (
    <section aria-labelledby="queue-heading">
      <PageHeader title="Review queue" titleId="queue-heading">
        Open disputes across all customers, oldest first.
      </PageHeader>
      <div className="space-y-6">
        <form aria-label="Filter the queue" onSubmit={(e) => e.preventDefault()} className="max-w-xs">
          <Field>
            <Label htmlFor={statusId}>Status</Label>
            <Select
              id={statusId}
              value={status ?? ''}
              onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}
            >
              <option value="">All open</option>
              {QUEUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {agentStatusLabel[s]}
                </option>
              ))}
            </Select>
          </Field>
        </form>
        {queue.isPending ? <Loading>Loading the queue…</Loading> : null}
        {failed ? (
          <LoadError message="We could not load the review queue. Please try again." onRetry={() => void queue.refetch()} />
        ) : null}
        {!queue.isPending && !failed && items.length === 0 ? <Empty>No disputes waiting.</Empty> : null}
        {items.length > 0 ? (
          <div className={cx(cardClass, 'overflow-x-auto')}>
            <table className="w-full text-sm">
              <caption className="sr-only">Disputes awaiting review</caption>
              <thead>
                <tr>
                  <th scope="col" className={headCellClass}>
                    Opened
                  </th>
                  <th scope="col" className={headCellClass}>
                    Reason
                  </th>
                  <th scope="col" className={headCellClass}>
                    Status
                  </th>
                  <th scope="col" className={headCellClass}>
                    Picked up by
                  </th>
                  <th scope="col" className={headCellClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <QueueRow key={item.disputeId} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {queue.hasNextPage && !failed ? (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              disabled={queue.isFetchingNextPage}
              onClick={() => void queue.fetchNextPage()}
            >
              {queue.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
};
