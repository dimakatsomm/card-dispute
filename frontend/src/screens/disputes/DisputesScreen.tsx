import { useInfiniteQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { routes } from '../../app/routes';
import { formatMoney } from '../../lib/format/money';
import { useMe } from '../home/useMe';
import { listDisputes, type Account, type DisputeFilters, type DisputeSummary, type ListError } from './api';
import {
  cardsFor,
  filtersFromParams,
  filtersToParams,
  hasAccountOrCardFilter,
  selectAccount,
  toggleStatus,
} from './filters';
import {
  DISPUTE_STATUSES,
  formatDateTime,
  reasonLabel,
  statusLabel,
  timelineLabel,
} from './labels';

const listErrorMessage: Readonly<Record<ListError, string>> = {
  FILTER_UNAVAILABLE:
    'Filtering by account or card is temporarily unavailable. Clear the account and card filters to see all your disputes.',
  BAD_FILTER: 'Those filters could not be applied. Please clear them and try again.',
  FAILED: 'We could not load your disputes. Please try again.',
};

const Filters = ({
  filters,
  accounts,
  accountsUnavailable,
  onChange,
}: {
  readonly filters: DisputeFilters;
  readonly accounts: ReadonlyArray<Account>;
  readonly accountsUnavailable: boolean;
  readonly onChange: (next: DisputeFilters) => void;
}) => {
  const accountSelectId = useId();
  const cardSelectId = useId();
  const cards = cardsFor(accounts, filters.accountId);
  return (
    <form aria-label="Filter disputes" onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend>Status</legend>
        {DISPUTE_STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={filters.status.includes(status)}
              onChange={() => onChange(toggleStatus(filters, status))}
            />
            {statusLabel[status]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={accountSelectId}>Account</label>
      <select
        id={accountSelectId}
        value={filters.accountId ?? ''}
        disabled={accountsUnavailable}
        onChange={(e) => onChange(selectAccount(filters, accounts, e.target.value || undefined))}
      >
        <option value="">All accounts</option>
        {accounts.map((a) => (
          <option key={a.accountId} value={a.accountId}>
            {a.accountType} {a.accountNumberMasked}
          </option>
        ))}
      </select>
      <label htmlFor={cardSelectId}>Card</label>
      <select
        id={cardSelectId}
        value={filters.cardId ?? ''}
        disabled={accountsUnavailable}
        onChange={(e) => onChange({ ...filters, cardId: e.target.value || undefined })}
      >
        <option value="">All cards</option>
        {cards.map((c) => (
          <option key={c.cardId} value={c.cardId}>
            {c.brand} ending {c.last4}
          </option>
        ))}
      </select>
      {accountsUnavailable ? <p>Account and card filters are unavailable right now.</p> : null}
    </form>
  );
};

const DisputeRow = ({ dispute }: { readonly dispute: DisputeSummary }) => (
  <li>
    <Link to={routes.disputeDetail(dispute.transactionId)}>
      {dispute.transaction ? dispute.transaction.merchantName : 'Transaction details unavailable'}
    </Link>
    {dispute.transaction ? (
      <span> {formatMoney(dispute.transaction.amount, dispute.transaction.currency)}</span>
    ) : null}
    <dl>
      <dt>Status</dt>
      <dd>{statusLabel[dispute.status]}</dd>
      <dt>Reason</dt>
      <dd>{reasonLabel[dispute.reasonCode]}</dd>
      <dt>Latest update</dt>
      <dd>
        {timelineLabel[dispute.lastEvent.type]},{' '}
        <time dateTime={dispute.lastEvent.at}>{formatDateTime(dispute.lastEvent.at)}</time>
      </dd>
    </dl>
  </li>
);

export const DisputesScreen = () => {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const setFilters = (next: DisputeFilters) => setParams(filtersToParams(next));

  const me = useMe();
  const accounts = me.data?.accounts ?? [];
  const accountsUnavailable = me.isError;

  const disputesQuery = useInfiniteQuery({
    queryKey: ['disputes', filters],
    queryFn: ({ pageParam }) => listDisputes(api)({ filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.ok ? (last.value.nextCursor ?? undefined) : undefined),
  });

  const pages = disputesQuery.data?.pages ?? [];
  const items = pages.flatMap((p) => (p.ok ? p.value.items : []));
  const failedPage = pages.find((p) => !p.ok);
  const listError: ListError | undefined = disputesQuery.isError
    ? 'FAILED'
    : failedPage && !failedPage.ok
      ? failedPage.error
      : undefined;

  return (
    <section aria-labelledby="disputes-heading">
      <h1 id="disputes-heading">Your disputes</h1>
      <Filters
        filters={filters}
        accounts={accounts}
        accountsUnavailable={accountsUnavailable}
        onChange={setFilters}
      />
      {disputesQuery.isPending ? <p role="status">Loading disputes…</p> : null}
      {listError ? (
        <div role="alert">
          <p>{listErrorMessage[listError]}</p>
          {listError === 'FILTER_UNAVAILABLE' && hasAccountOrCardFilter(filters) ? (
            <button
              type="button"
              onClick={() => setFilters({ ...filters, accountId: undefined, cardId: undefined })}
            >
              Clear account and card filters
            </button>
          ) : (
            <button type="button" onClick={() => void disputesQuery.refetch()}>
              Try again
            </button>
          )}
        </div>
      ) : null}
      {!disputesQuery.isPending && !listError && items.length === 0 ? <p>No disputes found.</p> : null}
      {items.length > 0 ? (
        <ul aria-label="Disputes">
          {items.map((d) => (
            <DisputeRow key={d.disputeId} dispute={d} />
          ))}
        </ul>
      ) : null}
      {disputesQuery.hasNextPage && !listError ? (
        <button
          type="button"
          disabled={disputesQuery.isFetchingNextPage}
          onClick={() => void disputesQuery.fetchNextPage()}
        >
          {disputesQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
};
