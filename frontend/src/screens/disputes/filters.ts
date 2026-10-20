import type { Account, DisputeFilters } from './api';
import { DISPUTE_STATUSES, type DisputeStatus } from './labels';

const isStatus = (value: string): value is DisputeStatus =>
  (DISPUTE_STATUSES as ReadonlyArray<string>).includes(value);

export const filtersFromParams = (params: URLSearchParams): DisputeFilters => ({
  status: params.getAll('status').filter(isStatus),
  accountId: params.get('accountId') || undefined,
  cardId: params.get('cardId') || undefined,
});

export const filtersToParams = (filters: DisputeFilters): URLSearchParams =>
  new URLSearchParams([
    ...filters.status.map((s): [string, string] => ['status', s]),
    ...(filters.accountId ? [['accountId', filters.accountId] as [string, string]] : []),
    ...(filters.cardId ? [['cardId', filters.cardId] as [string, string]] : []),
  ]);

export const toggleStatus = (filters: DisputeFilters, status: DisputeStatus): DisputeFilters => ({
  ...filters,
  status: filters.status.includes(status)
    ? filters.status.filter((s) => s !== status)
    : DISPUTE_STATUSES.filter((s) => s === status || filters.status.includes(s)),
});

export const selectAccount = (
  filters: DisputeFilters,
  accounts: ReadonlyArray<Account>,
  accountId: string | undefined,
): DisputeFilters => {
  const cardStillInAccount =
    !accountId ||
    accounts.some((a) => a.accountId === accountId && a.cards.some((c) => c.cardId === filters.cardId));
  return { ...filters, accountId, cardId: cardStillInAccount ? filters.cardId : undefined };
};

export const cardsFor = (accounts: ReadonlyArray<Account>, accountId: string | undefined) =>
  accounts.filter((a) => !accountId || a.accountId === accountId).flatMap((a) => a.cards);

export const hasAccountOrCardFilter = (filters: DisputeFilters): boolean =>
  Boolean(filters.accountId || filters.cardId);
