import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { queueItem } from '../../../test/agent/fixtures';
import { json, renderWithApi, urlsTo, type Handler } from '../../../test/support/api';
import { AgentQueueScreen } from './AgentQueueScreen';

const renderQueue = (handler: Handler, url = '/agent') =>
  renderWithApi({ routes: [{ path: '/agent', element: <AgentQueueScreen /> }], url, handler });

const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('AgentQueueScreen', () => {
  it('lists the queue and pages with the cursor the server returned', async () => {
    const { requests } = renderQueue((request) =>
      new URL(request.url).searchParams.get('cursor') === 'page-2'
        ? json({ items: [queueItem(3, { status: 'UNDER_REVIEW', pickedUpBy: 'Naledi M.' })], nextCursor: null })
        : json({ items: [queueItem(1), queueItem(2)], nextCursor: 'page-2' }),
    );

    expect(await screen.findByRole('link', { name: `Open dispute ${queueItem(1).disputeId}` })).toBeTruthy();
    expect(rows()).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Naledi M.')).toBeTruthy();
    expect(rows()).toHaveLength(3);
    expect(screen.getByRole('link', { name: `Open dispute ${queueItem(3).disputeId}` }).getAttribute('href')).toBe(
      `/agent/disputes/${queueItem(3).transactionId}`,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(urlsTo(requests, '/agent/review-queue').map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'page-2',
    ]);
  });

  it('filters by status, and sends no status for all open disputes', async () => {
    const { requests } = renderQueue(() => json({ items: [queueItem(1)], nextCursor: null }));
    await screen.findByRole('table');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'UNDER_REVIEW');

    await screen.findByRole('table');
    expect(urlsTo(requests, '/agent/review-queue').map((url) => url.searchParams.getAll('status'))).toEqual([
      [],
      ['UNDER_REVIEW'],
    ]);
  });
});
