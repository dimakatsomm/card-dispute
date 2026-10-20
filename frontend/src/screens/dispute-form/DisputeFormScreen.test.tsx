import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { installFakeXhr } from '../../../test/dispute-form/fakeXhr';
import { json, problem, renderWithApi, type Handler } from '../../../test/support/api';
import { hexToBase64, sha256Hex } from '../../lib/upload';
import { DisputeFormScreen } from './index';

const transactionId = '0192f0c1-0000-7000-8000-0000000000a1';
const VALID_DESCRIPTION = 'I did not make this purchase.';

const instructionFor = async (file: File, url: string, checksum?: string) => ({
  evidenceId: '0192f0c1-0000-7000-8000-0000000000e1',
  method: 'PUT',
  url,
  headers: {
    'Content-Type': file.type,
    'Content-Length': String(file.size),
    'x-amz-checksum-sha256': checksum ?? hexToBase64(await sha256Hex(file)),
  },
  expiresAt: '2026-10-19T10:10:00Z',
});

const created = (uploads: ReadonlyArray<unknown>) =>
  json(
    {
      disputeId: '0192f0c1-0000-7000-8000-0000000000d1',
      transactionId,
      status: 'SUBMITTED',
      reasonCode: 'FRAUD',
      description: VALID_DESCRIPTION,
      transaction: null,
      evidence: [],
      version: 1,
      createdAt: '2026-10-19T10:00:00Z',
      updatedAt: '2026-10-19T10:00:00Z',
      resolvedAt: null,
      resolutionNote: null,
      uploads,
    },
    { status: 201 },
  );

const renderScreen = (routes: Readonly<Record<string, Handler>> = {}) => {
  const { requests, router } = renderWithApi({
    routes: [
      { path: '/transactions/:transactionId/dispute', element: <DisputeFormScreen /> },
      { path: '/disputes/:transactionId', element: <h1>Dispute detail</h1> },
    ],
    url: `/transactions/${transactionId}/dispute`,
    handler: (request) => routes[`${request.method} ${new URL(request.url).pathname}`]?.(request) ?? json({}, { status: 500 }),
  });
  return { requests, router, user: userEvent.setup({ applyAccept: false }) };
};

const fillValidForm = async (user: ReturnType<typeof userEvent.setup>, description = VALID_DESCRIPTION) => {
  await user.selectOptions(screen.getByLabelText('Reason'), 'FRAUD');
  await user.type(screen.getByLabelText('What happened?'), description);
};

const describedText = (element: HTMLElement): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

const pdf = (name = 'statement.pdf', content = 'pdf-bytes') => new File([content], name, { type: 'application/pdf' });

describe('DisputeFormScreen', () => {
  it.each([
    ['more than 5 files', Array.from({ length: 6 }, (_, i) => pdf(`s${i}.pdf`)), /up to 5 files/],
    ['a file over 10 MB', [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' })], /big\.pdf is larger than 10 MB/],
    ['a file whose type is not PDF/JPEG/PNG', [new File(['x'], 'notes.txt', { type: 'text/plain' })], /notes\.txt isn't a PDF, JPEG or PNG/],
    ['a file whose extension contradicts its type', [new File(['x'], 'photo.exe', { type: 'image/png' })], /photo\.exe isn't a PDF, JPEG or PNG/],
  ])('rejects %s client-side and declares nothing to the API', async (_, files, message) => {
    const { requests, user } = renderScreen({ [`POST /api/dispute/${transactionId}`]: () => created([]) });
    await fillValidForm(user);

    await user.upload(screen.getByLabelText('Evidence (optional)'), files);

    expect(screen.getByRole('alert').textContent).toMatch(message);
    expect(requests).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(await requests[0]?.json()).not.toHaveProperty('evidence');
  });

  it.each([
    ['9 code points (10 UTF-16 units) is rejected', 'abcdefgh\u{1F600}', false],
    ['10 code points is accepted', 'abcdefghi\u{1F600}', true],
  ])('description of %s', async (_, description, accepted) => {
    const { requests, user } = renderScreen({ [`POST /api/dispute/${transactionId}`]: () => created([]) });
    await fillValidForm(user, description);

    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    if (accepted) {
      expect(await screen.findByRole('heading', { name: 'Dispute detail' })).toBeTruthy();
      expect(requests).toHaveLength(1);
    } else {
      const field = screen.getByLabelText('What happened?');
      expect(document.activeElement).toBe(field);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(describedText(field)).toMatch(/Enter at least 10 characters/);
      expect(requests).toHaveLength(0);
    }
  });

  it('navigates to the existing dispute on 409 ALREADY_DISPUTED', async () => {
    const { router, user } = renderScreen({
      [`POST /api/dispute/${transactionId}`]: () => problem(409, 'ALREADY_DISPUTED'),
    });
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect(await screen.findByRole('heading', { name: 'Dispute detail' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/disputes/${transactionId}`);
  });

  it.each([
    [400, 'INVALID_REASON', 'Choose a valid reason for the dispute.'],
    [400, 'INVALID_DESCRIPTION', 'The description must be between 10 and 2000 characters.'],
    [422, 'OUTSIDE_WINDOW', 'This transaction is outside the period in which it can be disputed.'],
    [400, 'VALIDATION_FAILED', "Some details weren't accepted. Check the form and try again."],
  ])('shows the message for %i %s and keeps the form usable', async (status, code, message) => {
    const { user } = renderScreen({ [`POST /api/dispute/${transactionId}`]: () => problem(status, code) });
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit dispute' }).disabled).toBe(false);
  });

  it('retries a failed upload by requesting a fresh URL, then opens the dispute', async () => {
    const xhrs = installFakeXhr();
    const file = pdf();
    const { requests, user } = renderScreen({
      [`POST /api/dispute/${transactionId}`]: async () => created([await instructionFor(file, 'https://quarantine.example/first')]),
      [`POST /api/dispute/${transactionId}/evidence`]: async () =>
        json({ uploads: [await instructionFor(file, 'https://quarantine.example/second')] }, { status: 201 }),
    });
    await fillValidForm(user);
    await user.upload(screen.getByLabelText('Evidence (optional)'), file);
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    await waitFor(() => expect(xhrs.instances).toHaveLength(1));
    xhrs.instances[0]?.failNetwork();
    await user.click(await screen.findByRole('button', { name: 'Retry statement.pdf' }));
    await waitFor(() => expect(xhrs.instances).toHaveLength(2));
    xhrs.instances[1]?.respond(200);

    expect(await screen.findByRole('heading', { name: 'Dispute detail' })).toBeTruthy();
    const evidenceRequest = requests.find((r) => r.url.endsWith('/evidence'));
    expect(await evidenceRequest?.json()).toEqual({
      evidence: [{ fileName: 'statement.pdf', contentType: 'application/pdf', sizeBytes: file.size, sha256: await sha256Hex(file) }],
    });
    expect(xhrs.instances[1]?.url()).toBe('https://quarantine.example/second');
    expect(xhrs.instances[1]?.headers()).not.toHaveProperty('Authorization');
  });

  it('does not upload when the returned checksum does not match the file, and says so', async () => {
    const xhrs = installFakeXhr();
    const file = pdf();
    const { user } = renderScreen({
      [`POST /api/dispute/${transactionId}`]: async () =>
        created([await instructionFor(file, 'https://quarantine.example/first', hexToBase64('00'.repeat(32)))]),
    });
    await fillValidForm(user);
    await user.upload(screen.getByLabelText('Evidence (optional)'), file);

    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect((await screen.findByRole('alert')).textContent).toBe("The upload link we received didn't match this file.");
    expect(xhrs.instances).toHaveLength(0);
  });
});
