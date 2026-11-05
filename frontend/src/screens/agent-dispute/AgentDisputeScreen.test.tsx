import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { agentDispute, agentTransactionId, digestA, digestB } from '../../../test/agent/fixtures';
import { json, pathOf, problem, renderWithApi } from '../../../test/support/api';
import type { AgentDispute } from './api';
import { AgentDisputeScreen } from './AgentDisputeScreen';

type Put = { readonly path: string; readonly body: unknown };

const renderDetail = (options: {
  readonly reads: ReadonlyArray<AgentDispute>;
  readonly put: (path: string) => Response;
  readonly download?: (path: string) => Response | Promise<Response>;
}) => {
  const calls = { gets: 0, puts: [] as Put[], downloads: [] as string[] };
  const handler = async (request: Request) => {
    if (options.download && pathOf(request).endsWith('/download')) {
      calls.downloads.push(pathOf(request));
      return options.download(pathOf(request));
    }
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

const evidenceItem = (
  n: number,
  status: AgentDispute['evidence'][number]['status'],
): AgentDispute['evidence'][number] => ({
  evidenceId: `0192f0c1-0000-7000-8000-00000000e${String(n).padStart(3, '0')}`,
  fileName: `file-${n}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 4096,
  status,
});

const stored = evidenceItem(1, 'STORED');
const downloadPath = `/agent/disputes/${agentTransactionId}/evidence/${stored.evidenceId}/download`;
const signedUrl = 'https://evidence.s3.eu-north-1.amazonaws.com/evidence/x?X-Amz-Signature=abc';

const fakeTab = (log: string[] = []) => {
  const tab = {
    opener: {} as unknown,
    location: { replace: vi.fn((url: string) => log.push(`navigate ${url}`)) },
    close: vi.fn(),
  };
  const open = vi.spyOn(window, 'open').mockImplementation(() => {
    log.push('open');
    return tab as unknown as Window;
  });
  return { tab, open };
};

const downloadButton = () => screen.findByRole('button', { name: `Download ${stored.fileName}` });

describe('AgentDisputeScreen evidence download', () => {
  it('offers Download only for STORED items', async () => {
    renderDetail({
      reads: [
        agentDispute({
          evidence: [stored, evidenceItem(2, 'PENDING'), evidenceItem(3, 'REJECTED'), evidenceItem(4, 'EXPIRED'), evidenceItem(5, 'ERASED')],
        }),
      ],
      put: () => problem(500),
    });

    const evidence = await screen.findByRole('list', { name: 'Evidence' });
    expect(within(evidence).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      `Download ${stored.fileName}`,
    ]);
  });

  it('opens a detached tab before calling the API, then sends it to the URL without rendering the file', async () => {
    const log: string[] = [];
    const { tab } = fakeTab(log);
    const calls = renderDetail({
      reads: [agentDispute({ evidence: [stored] })],
      put: () => problem(500),
      download: () => {
        log.push('api');
        return json({ url: signedUrl, expiresAt: '2026-11-05T10:01:00Z' });
      },
    });

    await userEvent.click(await downloadButton());

    await waitFor(() => expect(log).toEqual(['open', 'api', `navigate ${signedUrl}`]));
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    expect(calls.downloads).toEqual([downloadPath]);
    expect(document.querySelector('img, iframe, object, embed')).toBeNull();
    expect(document.body.innerHTML).not.toContain('X-Amz-Signature');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a blocked pop-up asks to allow pop-ups and never calls the API', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const calls = renderDetail({ reads: [agentDispute({ evidence: [stored] })], put: () => problem(500), download: () => json({}) });

    await userEvent.click(await downloadButton());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your browser blocked the download tab. Allow pop-ups for this site and try again.',
    );
    expect(calls.downloads).toEqual([]);
  });

  it('a double click makes one request and the button is disabled while it is in flight', async () => {
    const { open } = fakeTab();
    let respond: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const calls = renderDetail({ reads: [agentDispute({ evidence: [stored] })], put: () => problem(500), download: () => response });

    const button = await downloadButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    respond(json({ url: signedUrl, expiresAt: '2026-11-05T10:01:00Z' }));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls.downloads).toHaveLength(1);
  });

  it.each([
    ['409', () => problem(409, 'EVIDENCE_NOT_STORED'), "This file isn't available to download."],
    ['429 with Retry-After', () => json({ code: 'RATE_LIMITED', status: 429 }, { status: 429, headers: { 'Retry-After': '42' } }), 'Too many downloads — try again in 42 s'],
    ['503', () => problem(503), 'Download is unavailable right now.'],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), 'Download is unavailable right now.'],
    ['404', () => problem(404, 'NOT_FOUND'), 'This file could not be found. The evidence list has been refreshed.'],
    ['a javascript: url', () => json({ url: 'javascript:alert(document.domain)', expiresAt: '2026-11-05T10:01:00Z' }), 'Download is unavailable right now.'],
    ['a plain-http non-local url', () => json({ url: 'http://evidence.example/x', expiresAt: '2026-11-05T10:01:00Z' }), 'Download is unavailable right now.'],
  ] as const)('%s closes the tab and shows the reason next to the item', async (_case, download, message) => {
    const { tab } = fakeTab();
    renderDetail({ reads: [agentDispute({ evidence: [stored] })], put: () => problem(500), download });

    await userEvent.click(await downloadButton());

    const item = screen.getByRole('list', { name: 'Evidence' });
    expect((await within(item).findByRole('alert')).textContent).toBe(message);
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('a 409 reloads the dispute and keeps the message once the item is no longer STORED', async () => {
    fakeTab();
    const calls = renderDetail({
      reads: [agentDispute({ evidence: [stored] }), agentDispute({ evidence: [{ ...stored, status: 'EXPIRED' }] })],
      put: () => problem(500),
      download: () => problem(409, 'EVIDENCE_NOT_STORED'),
    });

    await userEvent.click(await downloadButton());

    expect(await screen.findByText('Expired (not uploaded in time)')).toBeTruthy();
    expect(calls.gets).toBe(2);
    expect(screen.queryByRole('button', { name: `Download ${stored.fileName}` })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe("This file isn't available to download.");
  });
});
