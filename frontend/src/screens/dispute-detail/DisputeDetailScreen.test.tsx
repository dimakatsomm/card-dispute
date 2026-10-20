import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, problem, renderWithApi, type Handler } from '../../../test/support/api';
import type { DisputeStatus } from '../disputes/labels';
import type { DisputeDetail } from './api';
import { DisputeDetailScreen } from './DisputeDetailScreen';

const transactionId = '0192f0c1-0000-7000-8000-0000000000t1';

const detail = (overrides: Partial<DisputeDetail> = {}): DisputeDetail => ({
  disputeId: '0192f0c1-0000-7000-8000-0000000000d1',
  transactionId,
  status: 'SUBMITTED',
  reasonCode: 'FRAUD',
  description: 'I did not make this purchase.',
  transaction: {
    accountId: '0192f0c1-0000-7000-8000-0000000000a1',
    cardId: '0192f0c1-0000-7000-8000-0000000000c1',
    amount: '125.50',
    currency: 'ZAR',
    merchantName: 'Corner Shop',
    transactionAt: '2026-09-01T10:00:00Z',
    postedAt: '2026-09-02T10:00:00Z',
  },
  evidence: [],
  version: 7,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  resolvedAt: null,
  resolutionNote: null,
  timeline: [{ type: 'SUBMITTED', at: '2026-10-01T10:00:00Z', by: 'CUSTOMER' }],
  ...overrides,
});

const getResponse = (body: unknown, etag = '"7"') => json(body, { headers: { ETag: etag } });

const renderDetail = (handler: Handler) =>
  renderWithApi({
    routes: [{ path: '/disputes/:transactionId', element: <DisputeDetailScreen /> }],
    url: `/disputes/${transactionId}`,
    handler,
  });

const recordingHandler = (put: (request: Request) => Response, get: () => Response = () => getResponse(detail())) => {
  const calls = { get: 0, puts: [] as Array<{ ifMatch: string | null; body: unknown }> };
  const handler: Handler = async (request) => {
    if (request.method === 'PUT') {
      calls.puts.push({ ifMatch: request.headers.get('If-Match'), body: await request.clone().json() });
      return put(request);
    }
    calls.get += 1;
    return get();
  };
  return { handler, calls };
};

describe('DisputeDetailScreen', () => {
  it.each<[DisputeStatus, { edit: boolean; withdraw: boolean; addEvidence: boolean }]>([
    ['SUBMITTED', { edit: true, withdraw: true, addEvidence: true }],
    ['UNDER_REVIEW', { edit: false, withdraw: true, addEvidence: true }],
    ['RESOLVED_ACCEPTED', { edit: false, withdraw: false, addEvidence: false }],
    ['RESOLVED_REJECTED', { edit: false, withdraw: false, addEvidence: false }],
    ['WITHDRAWN', { edit: false, withdraw: false, addEvidence: false }],
  ])('offers only the actions allowed while %s', async (status, expected) => {
    renderDetail(() => getResponse(detail({ status })));

    await screen.findByRole('heading', { name: /Corner Shop/ });

    expect(screen.queryByRole('button', { name: 'Edit dispute' }) !== null).toBe(expected.edit);
    expect(screen.queryByRole('button', { name: 'Withdraw dispute' }) !== null).toBe(expected.withdraw);
    expect(screen.queryByRole('link', { name: 'Add evidence' })?.getAttribute('href') ?? null).toBe(
      expected.addEvidence ? `/disputes/${transactionId}/evidence` : null,
    );
  });

  it('edit sends only the changed field with If-Match taken from the ETag', async () => {
    const { handler, calls } = recordingHandler(() => getResponse(detail({ version: 8 }), '"8"'), () =>
      getResponse(detail({ version: 7 }), '"etag-7"'),
    );
    renderDetail(handler);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit dispute' }));
    const description = screen.getByLabelText('Description');
    await userEvent.clear(description);
    await userEvent.type(description, 'Card was in my wallet the whole time.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Your changes have been saved.')).toBeTruthy();
    expect(calls.puts).toEqual([
      { ifMatch: '"etag-7"', body: { action: 'EDIT', description: 'Card was in my wallet the whole time.' } },
    ]);
  });

  it('withdraw warns that it is final and sends the PUT only after confirmation', async () => {
    const { handler, calls } = recordingHandler(() => getResponse(detail({ status: 'WITHDRAWN', version: 8 }), '"8"'));
    renderDetail(handler);

    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw dispute' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Withdraw this dispute?' });
    expect(within(dialog).getByText(/this transaction can never be disputed again/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep my dispute' }));
    expect(calls.puts).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw dispute' }));

    expect(await screen.findByText('Your dispute has been withdrawn.')).toBeTruthy();
    expect(calls.puts).toEqual([{ ifMatch: '"7"', body: { action: 'WITHDRAW' } }]);
  });

  it('cancelling the withdraw confirmation sends nothing', async () => {
    const { handler, calls } = recordingHandler(() => getResponse(detail()));
    renderDetail(handler);

    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw dispute' }));
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.puts).toHaveLength(0);
  });

  it.each([
    [412, 'PRECONDITION_FAILED', 'This dispute changed, please review it before trying again.'],
    [409, 'INVALID_TRANSITION', 'This dispute can no longer be changed that way. It now shows its current status.'],
  ])('a %i on withdraw reloads the dispute and explains why', async (status, code, message) => {
    const { handler, calls } = recordingHandler(
      () => problem(status, code),
      () => (calls.get === 0 ? getResponse(detail()) : getResponse(detail({ status: 'UNDER_REVIEW', version: 8 }), '"8"')),
    );
    renderDetail(handler);

    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw dispute' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Withdraw dispute' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(await screen.findByText('Under review')).toBeTruthy();
    expect(calls.get).toBe(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('timeline is an ordered list attributed to You/The bank and never shows agent identities', async () => {
    const timeline = [
      { type: 'SUBMITTED', at: '2026-10-01T10:00:00Z', by: 'CUSTOMER' },
      { type: 'UNDER_REVIEW', at: '2026-10-02T10:00:00Z', by: 'BANK', agentId: 'agent-42', actorId: 'ops-user-9' },
      { type: 'RESOLVED_ACCEPTED', at: '2026-10-03T10:00:00Z', by: 'BANK', detail: { note: 'Refund issued.' }, agentId: 'agent-42' },
    ];
    renderDetail(() =>
      getResponse({ ...detail({ status: 'RESOLVED_ACCEPTED', resolutionNote: 'Refund issued.', resolvedAt: '2026-10-03T10:00:00Z' }), timeline }),
    );

    const list = await screen.findByRole('list', { name: 'Dispute timeline' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('time')?.getAttribute('dateTime'))).toEqual(timeline.map((e) => e.at));
    expect(items[0]?.textContent).toContain('by You');
    expect(items[1]?.textContent).toContain('by The bank');
    expect(document.body.textContent).not.toMatch(/agent-42|ops-user-9/);
    expect(screen.getByRole('heading', { name: 'Resolution' })).toBeTruthy();
  });

  it('shows evidence statuses, including the reason a file was rejected', async () => {
    renderDetail(() =>
      getResponse(
        detail({
          evidence: [
            { evidenceId: '0192f0c1-0000-7000-8000-0000000000e1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 2048, status: 'PENDING' },
            { evidenceId: '0192f0c1-0000-7000-8000-0000000000e2', fileName: 'photo.png', contentType: 'image/png', sizeBytes: 2048, status: 'REJECTED', rejectionReason: 'MALWARE' },
          ],
        }),
      ),
    );

    const list = await screen.findByRole('list', { name: 'Evidence' });
    const [pending, rejected] = within(list).getAllByRole('listitem');
    expect(pending?.textContent).toContain('Scanning');
    expect(rejected?.textContent).toContain('Rejected: the file failed the security scan');
  });

  it('shows "details unavailable" when the transaction is null but still shows the dispute', async () => {
    renderDetail(() => getResponse(detail({ transaction: null })));

    expect(await screen.findByText('Transaction details unavailable right now.')).toBeTruthy();
    expect(screen.getByText('I did not make this purchase.')).toBeTruthy();
  });
});
