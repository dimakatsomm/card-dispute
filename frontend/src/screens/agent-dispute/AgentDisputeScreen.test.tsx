import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { agentDispute, agentTransactionId, digestA, digestB } from '../../../test/agent/fixtures';
import { json, pathOf, problem, renderWithApi } from '../../../test/support/api';
import type { AgentDispute } from './api';
import { AgentDisputeScreen } from './AgentDisputeScreen';

type Put = { readonly path: string; readonly body: unknown };

const renderDetail = (options: {
  readonly reads: ReadonlyArray<AgentDispute>;
  readonly put: (path: string) => Response;
}) => {
  const calls = { gets: 0, puts: [] as Put[] };
  const handler = async (request: Request) => {
    if (request.method === 'PUT') {
      const path = pathOf(request);
      calls.puts.push({ path, body: await request.clone().json() });
      return options.put(path);
    }
    const read = options.reads[Math.min(calls.gets, options.reads.length - 1)];
    calls.gets += 1;
    return json(read);
  };
  renderWithApi({
    routes: [{ path: '/agent/disputes/:transactionId', element: <AgentDisputeScreen /> }],
    url: `/agent/disputes/${agentTransactionId}`,
    handler,
  });
  return calls;
};

const resolveForm = () => screen.getByRole('form', { name: 'Resolve dispute' });

const resolveWith = async (outcome: RegExp, note: string) => {
  const form = resolveForm();
  await userEvent.click(within(form).getByRole('radio', { name: outcome }));
  const textarea = within(form).getByLabelText('Note to the customer');
  await userEvent.clear(textarea);
  if (note) await userEvent.type(textarea, note);
  await userEvent.click(within(form).getByRole('button', { name: 'Resolve dispute' }));
};

const reviewPath = `/agent/disputes/${agentTransactionId}/review`;
const resolutionPath = `/agent/disputes/${agentTransactionId}/resolution`;

describe('AgentDisputeScreen', () => {
  it('shows the transaction, evidence metadata without links and a timeline naming agents', async () => {
    renderDetail({
      reads: [
        agentDispute({
          status: 'UNDER_REVIEW',
          pickedUpBy: 'Naledi M.',
          evidence: [
            { evidenceId: '0192f0c1-0000-7000-8000-0000000000e1', fileName: 'tracking.pdf', contentType: 'application/pdf', sizeBytes: 4096, status: 'STORED' },
          ],
          timeline: [
            { type: 'SUBMITTED', at: '2026-10-01T10:00:00Z', by: 'CUSTOMER' },
            { type: 'UNDER_REVIEW', at: '2026-10-02T10:00:00Z', by: 'AGENT', agentName: 'Naledi M.' },
          ],
        }),
      ],
      put: () => problem(500),
    });

    expect(await screen.findByRole('heading', { name: 'Dispute: Parcel Store' })).toBeTruthy();
    expect(screen.getByText('Picked up by Naledi M.')).toBeTruthy();
    const evidence = screen.getByRole('list', { name: 'Evidence' });
    expect(within(evidence).getByText('tracking.pdf')).toBeTruthy();
    expect(within(evidence).queryByRole('link')).toBeNull();
    const timeline = screen.getByRole('list', { name: 'Dispute timeline' });
    expect(within(timeline).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dispute submitted by the customer'),
      expect.stringContaining('Picked up for review by Naledi M.'),
    ]);
  });

  it('says so when the transaction is unavailable and still offers the actions', async () => {
    renderDetail({ reads: [agentDispute({ transaction: null })], put: () => problem(500) });

    expect(await screen.findByText('Transaction details unavailable right now.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick up' })).toBeTruthy();
  });

  it('pick up sends the version and evidence digest it read and shows who picked it up', async () => {
    const calls = renderDetail({
      reads: [agentDispute()],
      put: () => json(agentDispute({ status: 'UNDER_REVIEW', version: 4, pickedUpBy: 'Naledi M.' })),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Pick up' }));

    expect(await screen.findByText('You picked up this dispute.')).toBeTruthy();
    expect(screen.getByText('Picked up by Naledi M.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pick up' })).toBeNull();
    expect(calls.puts).toEqual([{ path: reviewPath, body: { expectedVersion: 3, expectedEvidenceDigest: digestA } }]);
  });

  it.each([
    ['ACCEPTED', /^Accept/, 'RESOLVED_ACCEPTED', 'Dispute resolved: accepted.'],
    ['REJECTED', /^Reject/, 'RESOLVED_REJECTED', 'Dispute resolved: rejected.'],
  ] as const)('resolve %s sends outcome, note and the read version, then shows the result', async (outcome, radio, status, message) => {
    const note = 'Merchant confirmed the parcel was lost.';
    const calls = renderDetail({
      reads: [agentDispute({ status: 'UNDER_REVIEW', version: 4, pickedUpBy: 'Naledi M.' })],
      put: () => json(agentDispute({ status, version: 5, resolutionNote: note })),
    });
    await screen.findByRole('form', { name: 'Resolve dispute' });

    await resolveWith(radio, note);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Resolve dispute' })).toBeNull();
    expect(calls.puts).toEqual([
      { path: resolutionPath, body: { outcome, note, expectedVersion: 4, expectedEvidenceDigest: digestA } },
    ]);
  });

  it.each([
    ['shorter than 10 characters', 'Too short', 'The note must be at least 10 characters.'],
    ['longer than 2000 characters', 'x'.repeat(2001), 'The note must be at most 2000 characters.'],
  ])('does not send a note %s', async (_case, note, error) => {
    const calls = renderDetail({ reads: [agentDispute()], put: () => problem(500) });
    await screen.findByRole('form', { name: 'Resolve dispute' });

    const textarea = screen.getByLabelText('Note to the customer');
    await userEvent.click(within(resolveForm()).getByRole('radio', { name: /^Reject/ }));
    await userEvent.click(textarea);
    await userEvent.paste(note);
    await userEvent.click(screen.getByRole('button', { name: 'Resolve dispute' }));

    expect(screen.getByText(error)).toBeTruthy();
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(calls.puts).toHaveLength(0);
  });

  it('a 412 says the dispute changed, reloads it and keeps the draft note for a retry with the new view', async () => {
    const note = 'Merchant confirmed the parcel was lost.';
    const calls = renderDetail({
      reads: [agentDispute(), agentDispute({ version: 3, evidenceDigest: digestB, evidence: [
        { evidenceId: '0192f0c1-0000-7000-8000-0000000000e2', fileName: 'late.pdf', contentType: 'application/pdf', sizeBytes: 2048, status: 'PENDING' },
      ] })],
      put: () => (calls.puts.length === 1 ? problem(412, 'STALE_EVIDENCE') : json(agentDispute({ status: 'RESOLVED_ACCEPTED', version: 4 }))),
    });
    await screen.findByRole('form', { name: 'Resolve dispute' });

    await resolveWith(/^Accept/, note);

    expect((await screen.findByRole('alert')).textContent).toContain('This dispute changed since you opened it');
    expect(await screen.findByText('late.pdf')).toBeTruthy();
    expect(calls.gets).toBe(2);
    expect((screen.getByLabelText('Note to the customer') as HTMLTextAreaElement).value).toBe(note);

    await userEvent.click(screen.getByRole('button', { name: 'Resolve dispute' }));

    expect(await screen.findByText('Dispute resolved: accepted.')).toBeTruthy();
    expect(calls.puts.map((put) => put.body)).toEqual([
      { outcome: 'ACCEPTED', note, expectedVersion: 3, expectedEvidenceDigest: digestA },
      { outcome: 'ACCEPTED', note, expectedVersion: 3, expectedEvidenceDigest: digestB },
    ]);
  });

  it('a 409 shows the current state instead of the actions', async () => {
    const calls = renderDetail({
      reads: [agentDispute(), agentDispute({ status: 'WITHDRAWN', version: 4 })],
      put: () => problem(409, 'INVALID_TRANSITION'),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Pick up' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This dispute can no longer be changed that way. It now shows its current state.',
    );
    expect(await screen.findByText('Withdrawn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pick up' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Resolve dispute' })).toBeNull();
    expect(calls.gets).toBe(2);
  });
});
