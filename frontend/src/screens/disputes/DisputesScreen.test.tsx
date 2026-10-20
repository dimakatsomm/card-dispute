import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DisputeSummary } from './api';
import { DisputesScreen } from './DisputesScreen';
import { json, pathOf, problem, renderWithApi, type Handler } from '../../../test/support/api';

const accountId = '0192f0c1-0000-7000-8000-0000000000a1';
const cardId = '0192f0c1-0000-7000-8000-0000000000c1';

const summary = (n: number, transaction: DisputeSummary['transaction']): DisputeSummary => ({
  disputeId: `0192f0c1-0000-7000-8000-00000000d00${n}`,
  transactionId: `0192f0c1-0000-7000-8000-00000000t00${n}`,
  status: 'SUBMITTED',
  reasonCode: 'FRAUD',
  transaction,
  lastEvent: { type: 'SUBMITTED', at: '2026-10-01T10:00:00Z' },
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
});

const me = {
  userId: '0192f0c1-0000-7000-8000-000000000001',
  name: 'Thandi',
  surname: 'Nkosi',
  email: 'thandi@example.com',
  accounts: [
    {
      accountId,
      accountType: 'CHEQUE',
      accountNumberMasked: '****4821',
      currency: 'ZAR',
      status: 'ACTIVE',
      cards: [
        { cardId, accountId, brand: 'VISA', cardType: 'DEBIT', last4: '4821', expiryMonth: 9, expiryYear: 2028, expired: false, status: 'ACTIVE' },
      ],
    },
  ],
};

const handlerWith =
  (disputes: Handler): Handler =>
  (request) =>
    pathOf(request) === '/me' ? json(me) : disputes(request);

const renderList = (handler: Handler, url = '/disputes') =>
  renderWithApi({ routes: [{ path: '/disputes', element: <DisputesScreen /> }], url, handler: handlerWith(handler) });

describe('DisputesScreen', () => {
  it('shows "details unavailable" when transactions could not supply the transaction', async () => {
    renderList(() => json({ items: [summary(1, null)], nextCursor: null }));

    expect(await screen.findByRole('link', { name: 'Transaction details unavailable' })).toBeTruthy();
    expect(screen.getByText(/Dispute submitted/)).toBeTruthy();
  });

  it('pages with the server cursor and appends the next page', async () => {
    const { requests } = renderList((request) =>
      new URL(request.url).searchParams.get('cursor') === 'page-2'
        ? json({
            items: [summary(2, { accountId, cardId, amount: '20.00', currency: 'ZAR', merchantName: 'Second Shop', transactionAt: '2026-09-02T10:00:00Z', postedAt: null })],
            nextCursor: null,
          })
        : json({
            items: [summary(1, { accountId, cardId, amount: '10.00', currency: 'ZAR', merchantName: 'First Shop', transactionAt: '2026-09-01T10:00:00Z', postedAt: null })],
            nextCursor: 'page-2',
          }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second Shop')).toBeTruthy();
    expect(screen.getByText('First Shop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const disputeCalls = requests.filter((r) => pathOf(r) === '/disputes');
    expect(new URL(disputeCalls[1]?.url ?? '').searchParams.get('cursor')).toBe('page-2');
  });

  it('on 503 for an account filter, offers to clear the filter and then lists unfiltered disputes', async () => {
    const { requests } = renderList(
      (request) =>
        new URL(request.url).searchParams.has('accountId')
          ? problem(503, 'UNAVAILABLE')
          : json({ items: [summary(1, null)], nextCursor: null }),
      `/disputes?accountId=${accountId}`,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Clear account and card filters' }));

    expect(await screen.findByRole('link', { name: 'Transaction details unavailable' })).toBeTruthy();
    const last = requests.filter((r) => pathOf(r) === '/disputes').at(-1);
    expect(new URL(last?.url ?? '').searchParams.has('accountId')).toBe(false);
  });
});
