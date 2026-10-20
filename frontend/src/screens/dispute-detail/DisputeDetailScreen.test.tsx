import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { problem, renderWithApi, type Handler } from '../../../test/support/api';
import {
  disputeDetail as detail,
  disputeResponse as getResponse,
  evidenceItem,
  transactionId,
} from '../../../test/evidence/fixtures';
import type { DisputeStatus, RejectionReason } from '../disputes/labels';
import { DisputeDetailScreen } from './DisputeDetailScreen';

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

  it.each<[RejectionReason, string]>([
    ['MALWARE', 'Rejected: the file failed the security scan'],
    ['TYPE_MISMATCH', 'Rejected: the file contents do not match its type'],
    ['CHECKSUM', 'Rejected: the file does not match what was declared'],
    ['SIZE', 'Rejected: the file size does not match what was declared'],
  ])('a file rejected for %s explains why', async (rejectionReason, message) => {
    renderDetail(() => getResponse(detail({ evidence: [evidenceItem({ status: 'REJECTED', rejectionReason })] })));

    const list = await screen.findByRole('list', { name: 'Evidence' });
    expect(within(list).getByRole('listitem').textContent).toContain(message);
  });

  it.each<[DisputeStatus, boolean]>([
    ['SUBMITTED', true],
    ['UNDER_REVIEW', true],
    ['RESOLVED_REJECTED', false],
    ['WITHDRAWN', false],
  ])('an expired upload while %s links to add evidence: %s', async (status, linked) => {
    renderDetail(() => getResponse(detail({ status, evidence: [evidenceItem({ status: 'EXPIRED' })] })));

    const item = within(await screen.findByRole('list', { name: 'Evidence' })).getByRole('listitem');
    expect(item.textContent).toContain('Expired (not uploaded in time)');
    expect(within(item).queryByRole('link', { name: 'upload it again' })?.getAttribute('href') ?? null).toBe(
      linked ? `/disputes/${transactionId}/evidence` : null,
    );
  });

  it('an erased file renders neutrally without its tombstone name', async () => {
    renderDetail(() =>
      getResponse(detail({ status: 'RESOLVED_ACCEPTED', evidence: [evidenceItem({ status: 'ERASED', fileName: '[erased]' })] })),
    );

    const item = within(await screen.findByRole('list', { name: 'Evidence' })).getByRole('listitem');
    expect(item.textContent).toBe('File removed under our retention policy.');
  });

  it.each<[DisputeStatus, string | null, string | null]>([
    ['RESOLVED_ACCEPTED', 'Refund issued.', 'Note from the bank: Refund issued.'],
    ['RESOLVED_REJECTED', 'Merchant proved delivery.', 'Note from the bank: Merchant proved delivery.'],
    ['RESOLVED_ACCEPTED', null, null],
  ])('a %s resolution shows the note %s', async (status, resolutionNote, shown) => {
    renderDetail(() => getResponse(detail({ status, resolutionNote, resolvedAt: '2026-10-03T10:00:00Z' })));

    await screen.findByRole('heading', { name: 'Resolution' });
    expect(screen.queryByText(/^Note from the bank/)?.textContent ?? null).toBe(shown);
  });

  it('an erased dispute says it was removed under the retention policy and never shows tombstones', async () => {
    renderDetail(() =>
      getResponse(
        detail({
          status: 'RESOLVED_REJECTED',
          description: '[erased]',
          resolutionNote: null,
          resolvedAt: '2025-09-01T10:00:00Z',
          evidence: [evidenceItem({ status: 'ERASED', fileName: '[erased]' })],
          timeline: [
            { type: 'SUBMITTED', at: '2025-08-01T10:00:00Z', by: 'CUSTOMER' },
            { type: 'EVIDENCE_ADDED', at: '2025-08-01T10:05:00Z', by: 'BANK', detail: { fileName: '[erased]' } },
            { type: 'RESOLVED_REJECTED', at: '2025-09-01T10:00:00Z', by: 'BANK', detail: { note: '[erased]' } },
          ],
        }),
      ),
    );

    expect(await screen.findByText('Some details of this dispute were removed under our retention policy.')).toBeTruthy();
    expect(screen.getByText('Removed under our retention policy')).toBeTruthy();
    expect(document.body.textContent).not.toContain('[erased]');
    expect(document.body.textContent).not.toContain('Note from the bank');
  });

  it('shows "details unavailable" when the transaction is null but still shows the dispute', async () => {
    renderDetail(() => getResponse(detail({ transaction: null })));

    expect(await screen.findByText('Transaction details unavailable right now.')).toBeTruthy();
    expect(screen.getByText('I did not make this purchase.')).toBeTruthy();
  });
});
