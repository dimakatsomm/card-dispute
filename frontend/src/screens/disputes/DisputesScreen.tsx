import { useInfiniteQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { routes } from '../../app/routes';
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
  definitionListClass,
  disputeStatusTone,
  errorCardClass,
  labelClass,
  linkClass,
  mutedClass,
  termClass,
} from '../../components/ui';
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

const chipClass = cx(
  'inline-flex cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-zinc-700',
  'hover:bg-zinc-50 has-checked:border-accent-line has-checked:bg-accent-soft has-checked:text-accent-strong',
  'has-focus-visible:ring-2 has-focus-visible:ring-focus/40 motion-safe:transition-colors',
);

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
    <form aria-label="Filter disputes" onSubmit={(e) => e.preventDefault()} className={cx(cardClass, 'space-y-5 p-5')}>
      <fieldset>
        <legend className={cx(labelClass, 'mb-2')}>Status</legend>
        <div className="flex flex-wrap gap-2">
          {DISPUTE_STATUSES.map((status) => (
            <label key={status} className={chipClass}>
              <input
                type="checkbox"
                className="size-3.5 accent-accent focus-visible:outline-hidden"
                checked={filters.status.includes(status)}
                onChange={() => onChange(toggleStatus(filters, status))}
              />
              {statusLabel[status]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <Label htmlFor={accountSelectId}>Account</Label>
          <Select
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
          </Select>
        </Field>
        <Field>
          <Label htmlFor={cardSelectId}>Card</Label>
          <Select
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
          </Select>
        </Field>
      </div>
      {accountsUnavailable ? <p className={mutedClass}>Account and card filters are unavailable right now.</p> : null}
    </form>
  );
};

const DisputeRow = ({ dispute }: { readonly dispute: DisputeSummary }) => (
  <li className={cx(cardClass, 'space-y-4 p-5')}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <Link to={routes.disputeDetail(dispute.transactionId)} className={cx(linkClass, 'text-base')}>
        {dispute.transaction ? dispute.transaction.merchantName : 'Transaction details unavailable'}
      </Link>
      {dispute.transaction ? (
        <span className="font-semibold text-ink tabular-nums">
          {' '}
          {formatMoney(dispute.transaction.amount, dispute.transaction.currency)}
        </span>
      ) : null}
    </div>
    <dl className={definitionListClass}>
      <dt className={termClass}>Status</dt>
      <dd>
        <Badge tone={disputeStatusTone[dispute.status]}>{statusLabel[dispute.status]}</Badge>
      </dd>
      <dt className={termClass}>Reason</dt>
      <dd>{reasonLabel[dispute.reasonCode]}</dd>
      <dt className={termClass}>Latest update</dt>
      <dd>
        {timelineLabel[dispute.lastEvent.type]},{' '}
        <time dateTime={dispute.lastEvent.at} className="text-muted">
          {formatDateTime(dispute.lastEvent.at)}
        </time>
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
      <PageHeader title="Your disputes" titleId="disputes-heading" />
      <div className="space-y-6">
        <Filters
          filters={filters}
          accounts={accounts}
          accountsUnavailable={accountsUnavailable}
          onChange={setFilters}
        />
        {disputesQuery.isPending ? <Loading>Loading disputes…</Loading> : null}
        {listError ? (
          <div role="alert" className={errorCardClass}>
            <p>{listErrorMessage[listError]}</p>
            {listError === 'FILTER_UNAVAILABLE' && hasAccountOrCardFilter(filters) ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFilters({ ...filters, accountId: undefined, cardId: undefined })}
              >
                Clear account and card filters
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void disputesQuery.refetch()}>
                Try again
              </Button>
            )}
          </div>
        ) : null}
        {!disputesQuery.isPending && !listError && items.length === 0 ? <Empty>No disputes found.</Empty> : null}
        {items.length > 0 ? (
          <ul aria-label="Disputes" className="space-y-3">
            {items.map((d) => (
              <DisputeRow key={d.disputeId} dispute={d} />
            ))}
          </ul>
        ) : null}
        {disputesQuery.hasNextPage && !listError ? (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              disabled={disputesQuery.isFetchingNextPage}
              onClick={() => void disputesQuery.fetchNextPage()}
            >
              {disputesQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
};
