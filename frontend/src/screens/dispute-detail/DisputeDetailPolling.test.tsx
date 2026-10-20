import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disputeDetail as detail,
  disputeResponse,
  evidenceItem,
  setTabVisibility,
  transactionId,
} from '../../../test/evidence/fixtures';
import { problem, renderWithApi, type Handler } from '../../../test/support/api';
import { MAX_POLLS, POLL_INTERVAL_MS } from './core';
import { DisputeDetailScreen } from './DisputeDetailScreen';

type Reply = () => Response | Promise<Response>;

const pending = detail({ evidence: [evidenceItem({ status: 'PENDING' })] });
const stored = detail({
  evidence: [evidenceItem({ status: 'STORED' })],
  timeline: [
    ...pending.timeline,
    { type: 'EVIDENCE_ADDED', at: '2026-10-01T10:05:00Z', by: 'BANK', detail: { fileName: 'receipt.pdf' } },
  ],
});

const serve = (gets: ReadonlyArray<Reply>, put: Reply = () => disputeResponse(detail({ version: 9 }), '"9"')) => {
  const seen = { gets: 0, ifMatch: [] as Array<string | null> };
  const handler: Handler = (request) => {
    if (request.method === 'PUT') {
      seen.ifMatch.push(request.headers.get('If-Match'));
      return put();
    }
    const reply = gets[Math.min(seen.gets, gets.length - 1)];
    seen.gets += 1;
    return reply ? reply() : problem(500);
  };
  return { handler, seen };
};

const renderDetail = (handler: Handler) =>
  renderWithApi({
    routes: [{ path: '/disputes/:transactionId', element: <DisputeDetailScreen /> }],
    url: `/disputes/${transactionId}`,
    handler,
  });

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const loaded = () => screen.findByRole('heading', { name: /Corner Shop/ });

describe('DisputeDetailScreen evidence polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('PENDING becoming STORED shows "Evidence added" and announces it without a reload, then stops', async () => {
    const { handler, seen } = serve([() => disputeResponse(pending), () => disputeResponse(stored)]);
    const { container } = renderDetail(handler);
    await loaded();
    const live = container.querySelector('[aria-live="polite"]');
    expect(screen.queryByText('Evidence added')).toBeNull();

    await advance(POLL_INTERVAL_MS);

    expect(within(screen.getByRole('list', { name: 'Dispute timeline' })).getByText('Evidence added')).toBeTruthy();
    expect(live?.textContent).toBe('receipt.pdf: Stored.');
    await advance(POLL_INTERVAL_MS * 5);
    expect(seen.gets).toBe(2);
  });

  it('announces a dispute status change found by a poll', async () => {
    const { handler } = serve([() => disputeResponse(pending), () => disputeResponse({ ...pending, status: 'UNDER_REVIEW' })]);
    const { container } = renderDetail(handler);
    await loaded();

    await advance(POLL_INTERVAL_MS);

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Dispute status is now Under review.');
  });

  it('makes no extra requests when nothing is PENDING', async () => {
    const { handler, seen } = serve([() => disputeResponse(stored)]);
    renderDetail(handler);
    await loaded();

    await advance(POLL_INTERVAL_MS * 10);

    expect(seen.gets).toBe(1);
  });

  it('stops after the capped window, says it is still checking, and Refresh checks again', async () => {
    const { handler, seen } = serve([() => disputeResponse(pending)]);
    renderDetail(handler);
    await loaded();

    await advance(POLL_INTERVAL_MS * (MAX_POLLS + 5));

    expect(seen.gets).toBe(MAX_POLLS);
    expect(screen.getByText(/We are still checking your files/)).toBeTruthy();

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Refresh' }));
    await advance(POLL_INTERVAL_MS);

    expect(seen.gets).toBe(MAX_POLLS + 2);
    expect(screen.queryByText(/We are still checking your files/)).toBeNull();
  });

  it('stops polling on unmount', async () => {
    const { handler, seen } = serve([() => disputeResponse(pending)]);
    const { unmount } = renderDetail(handler);
    await loaded();

    unmount();
    await advance(POLL_INTERVAL_MS * 5);

    expect(seen.gets).toBe(1);
  });

  it('does not poll while the tab is hidden and resumes when it is visible again', async () => {
    const { handler, seen } = serve([() => disputeResponse(pending)]);
    renderDetail(handler);
    await loaded();

    setTabVisibility('hidden');
    await advance(POLL_INTERVAL_MS * 5);
    expect(seen.gets).toBe(1);

    await act(async () => setTabVisibility('visible'));
    await advance(POLL_INTERVAL_MS);
    expect(seen.gets).toBeGreaterThan(1);
  });

  it('a refetch keeps the open edit draft and the save uses the refreshed ETag', async () => {
    const { handler, seen } = serve([
      () => disputeResponse(pending, '"7"'),
      () => disputeResponse({ ...stored, version: 8 }, '"8"'),
    ]);
    renderDetail(handler);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Edit dispute' }));
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Card was in my wallet the whole time.');
    await advance(POLL_INTERVAL_MS);

    expect(screen.getByText('Evidence added')).toBeTruthy();
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Card was in my wallet the whole time.');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Your changes have been saved.')).toBeTruthy();
    expect(seen.ifMatch).toEqual(['"8"']);
  });

  it.each<[string, Reply]>([
    ['a 503', () => problem(503)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('the withdraw dialog stays open when a poll gets %s', async (_label, failure) => {
    const { handler, seen } = serve([() => disputeResponse(pending), failure]);
    renderDetail(handler);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Withdraw dispute' }));
    await advance(POLL_INTERVAL_MS);

    expect(seen.gets).toBe(2);
    expect(screen.getByRole('alertdialog', { name: 'Withdraw this dispute?' })).toBeTruthy();
  });
});
