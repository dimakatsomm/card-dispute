import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, pathOf, renderWithApi, urlsTo } from '../../../test/support/api';
import { ids, me, page, txn } from '../../../test/transactions/fixtures';
import { HomeScreen } from '../home';
import { AccountScreen } from '.';

const routes = [
  { path: '/', element: <HomeScreen /> },
  { path: '/accounts/:accountId', element: <AccountScreen /> },
];

describe('AccountScreen', () => {
  it("lists the account's cards from the cached /me and its transactions filtered by accountId", async () => {
    const { requests } = renderWithApi({
      routes,
      url: '/',
      handler: (request) => {
        if (pathOf(request) === '/me') return json(me);
        return new URL(request.url).searchParams.get('accountId') === ids.accountA
          ? json(page([txn(5, { merchantName: 'Account A shop' })]))
          : json(page([txn(1)]));
      },
    });

    await userEvent.click(await screen.findByRole('link', { name: 'Cheque account ****4821' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Cheque account ****4821' })).toBeDefined();
    const cards = within(screen.getByRole('list', { name: 'Cards on Cheque account ****4821' }));
    expect(cards.getByRole('link', { name: 'Visa debit card ending 1111' })).toBeDefined();
    expect(cards.getByRole('link', { name: 'Visa debit card ending 2222 (Expired)' })).toBeDefined();
    expect(screen.queryByText(/ending 3333/)).toBeNull();
    expect(await screen.findByRole('rowheader', { name: 'Account A shop' })).toBeDefined();

    expect(urlsTo(requests, '/me')).toHaveLength(1);
    expect(
      urlsTo(requests, '/transactions').some((url) => url.searchParams.get('accountId') === ids.accountA),
    ).toBe(true);
  });
});
