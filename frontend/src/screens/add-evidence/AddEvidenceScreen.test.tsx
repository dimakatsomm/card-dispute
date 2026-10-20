import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { installFakeXhr } from '../../../test/dispute-form/fakeXhr';
import { json, pathOf, problem, renderWithApi, type Handler } from '../../../test/support/api';
import { hexToBase64, sha256Hex } from '../../lib/upload';
import { AddEvidenceScreen } from '.';

const transactionId = '0192f0c1-0000-7000-8000-0000000000a1';
const evidencePath = `/dispute/${transactionId}/evidence`;

const uploadsFor = async (file: File, url: string) =>
  json(
    {
      uploads: [
        {
          evidenceId: '0192f0c1-0000-7000-8000-0000000000e1',
          method: 'PUT',
          url,
          headers: {
            'Content-Type': file.type,
            'Content-Length': String(file.size),
            'x-amz-checksum-sha256': hexToBase64(await sha256Hex(file)),
          },
          expiresAt: '2026-10-19T10:10:00Z',
        },
      ],
    },
    { status: 201 },
  );

const renderScreen = (handler: Handler) => {
  const view = renderWithApi({
    routes: [
      { path: '/disputes/:transactionId/evidence', element: <AddEvidenceScreen /> },
      { path: '/disputes/:transactionId', element: <h1>Dispute detail</h1> },
    ],
    url: `/disputes/${transactionId}/evidence`,
    handler,
  });
  return { ...view, user: userEvent.setup({ applyAccept: false }) };
};

const pdf = () => new File(['pdf-bytes'], 'receipt.pdf', { type: 'application/pdf' });

describe('AddEvidenceScreen', () => {
  it('declares files only via /evidence, retries by re-declaring the same file, then opens the dispute', async () => {
    const xhrs = installFakeXhr();
    const file = pdf();
    const urls = ['https://quarantine.example/first', 'https://quarantine.example/second'];
    const { requests, router, user } = renderScreen(async (request) =>
      pathOf(request) === evidencePath ? uploadsFor(file, urls.shift() ?? '') : json({}, { status: 500 }),
    );

    await user.upload(screen.getByLabelText('Files'), file);
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    await waitFor(() => expect(xhrs.instances).toHaveLength(1));
    xhrs.instances[0]?.failNetwork();
    await user.click(await screen.findByRole('button', { name: 'Retry receipt.pdf' }));
    await waitFor(() => expect(xhrs.instances).toHaveLength(2));
    xhrs.instances[1]?.respond(200);

    expect(await screen.findByRole('heading', { name: 'Dispute detail' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/disputes/${transactionId}`);
    expect(requests.map((r) => `${r.method} ${pathOf(r)}`)).toEqual([`POST ${evidencePath}`, `POST ${evidencePath}`]);
    const declaration = { fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: file.size, sha256: await sha256Hex(file) };
    expect(await Promise.all(requests.map((r) => r.json()))).toEqual([{ evidence: [declaration] }, { evidence: [declaration] }]);
    expect(xhrs.instances[1]?.url()).toBe('https://quarantine.example/second');
  });

  it('explains a closed dispute and uploads nothing', async () => {
    const xhrs = installFakeXhr();
    const { user } = renderScreen(() => problem(409, 'INVALID_TRANSITION'));

    await user.upload(screen.getByLabelText('Files'), pdf());
    await user.click(screen.getByRole('button', { name: 'Add files' }));

    expect((await screen.findByRole('alert')).textContent).toBe('This dispute is closed, so no more files can be added.');
    expect(xhrs.instances).toHaveLength(0);
  });
});
