import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, problem, renderWithApi, urlsTo, type Handler } from '../../../test/support/api';
import { page, txn } from '../../../test/transactions/fixtures';
import { TransactionList } from './TransactionList';
import type { EligibilityReason } from './types';

const renderList = (handler: Handler) =>
  renderWithApi({ routes: [{ path: '/', element: <TransactionList filter={{}} caption="Transactions" /> }], url: '/', handler });

const rowOf = async (merchant: string) => {
  const header = await screen.findByRole('rowheader', { name: merchant });
  const row = header.closest('tr');
  if (!row) throw new Error(`no row for ${merchant}`);
  return within(row);
};

const DISPUTE_LINK = /^Dispute .+ on /;

describe('TransactionList', () => {
  it('shows the Dispute link only when disputable.allowed is true', async () => {
    const allowed = txn(1);
    const blocked = txn(2, { disputable: { allowed: false, reason: 'OUTSIDE_WINDOW' } });
    renderList(() => json(page([allowed, blocked])));

    const allowedRow = await rowOf('Merchant 1');
    expect(allowedRow.getByRole('link', { name: DISPUTE_LINK }).getAttribute('href')).toBe(
      `/transactions/${allowed.transactionId}/dispute`,
    );
    expect((await rowOf('Merchant 2')).queryByRole('link', { name: DISPUTE_LINK })).toBeNull();
  });

  const reasonCases: Readonly<Record<EligibilityReason, RegExp>> = {
    ALREADY_DISPUTED: /already been disputed/i,
    CARD_EXPIRED: /card has expired/i,
    TXN_NOT_POSTED: /only posted transactions/i,
    TXN_TYPE_NOT_DISPUTABLE: /type of transaction can't be disputed/i,
    OUTSIDE_WINDOW: /time limit .* has passed/i,
    UNAVAILABLE: /temporarily unavailable/i,
  };

  it.each(Object.entries(reasonCases))('explains %s instead of offering a Dispute link', async (reason, message) => {
    renderList(() =>
      json(page([txn(1, { disputable: { allowed: false, reason: reason as EligibilityReason } })])),
    );

    const row = await rowOf('Merchant 1');
    expect(row.getByText(message)).toBeDefined();
    expect(row.queryByRole('link', { name: DISPUTE_LINK })).toBeNull();
  });

  it('requests the next page with nextCursor and stops when it is null', async () => {
    const { requests } = renderList((request) =>
      new URL(request.url).searchParams.get('cursor') === 'cursor-2' ? json(page([txn(2)])) : json(page([txn(1)], 'cursor-2')),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Load more transactions' }));

    expect(await screen.findByRole('rowheader', { name: 'Merchant 2' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Merchant 1' })).toBeDefined();
    expect(urlsTo(requests, '/transactions').map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'cursor-2',
    ]);
    expect(screen.queryByRole('button', { name: 'Load more transactions' })).toBeNull();
  });

  it('shows an error with a retry that reloads the list', async () => {
    const responses = [problem(503), json(page([txn(1)]))];
    renderList(() => responses.shift() ?? problem(500));

    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('rowheader', { name: 'Merchant 1' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
