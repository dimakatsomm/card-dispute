import { DISPUTE_STATUSES, EVIDENCE_REJECTION_REASONS, parseDisputeEvent, type DisputeEvent } from '@cd/dispute-domain';
import { describe, expect, it } from 'vitest';
import { renderEmail } from '../../src/core/templates.ts';
import {
  DISPUTE_A,
  NAME_A,
  OCCURRED_DATE_SAST,
  rejectedEvent,
  statusEvent,
  storedEvent,
} from '../support.ts';

const event = (raw: unknown): DisputeEvent => {
  const parsed = parseDisputeEvent(raw);
  if (!parsed.ok) throw new Error(parsed.error.issues.join('; '));
  return parsed.value;
};

const RAW_CODES = [...DISPUTE_STATUSES, ...EVIDENCE_REJECTION_REASONS];

describe('renderEmail', () => {
  it.each([
    ['DisputeCreated', statusEvent('DisputeCreated', 'SUBMITTED'), 'We have received your dispute', 'Submitted'],
    ['DisputeEdited', statusEvent('DisputeEdited', 'UNDER_REVIEW'), 'Your dispute has been updated', 'Under review'],
    ['to SUBMITTED', statusEvent('DisputeStatusChanged', 'SUBMITTED'), 'Your dispute has been submitted', 'Submitted'],
    ['to UNDER_REVIEW', statusEvent('DisputeStatusChanged', 'UNDER_REVIEW'), 'Your dispute is under review', 'Under review'],
    [
      'to RESOLVED_ACCEPTED',
      statusEvent('DisputeStatusChanged', 'RESOLVED_ACCEPTED'),
      'Your dispute was resolved in your favour',
      'Resolved in your favour',
    ],
    [
      'to RESOLVED_REJECTED',
      statusEvent('DisputeStatusChanged', 'RESOLVED_REJECTED'),
      'Your dispute has been resolved',
      'Resolved: declined',
    ],
    ['to WITHDRAWN', statusEvent('DisputeStatusChanged', 'WITHDRAWN'), 'Your dispute has been withdrawn', 'Withdrawn'],
    ['EvidenceStored', storedEvent(), 'Your evidence has been added', 'Evidence added'],
    ['EvidenceRejected', rejectedEvent('MALWARE'), 'We could not accept a file you uploaded', 'Evidence not accepted'],
  ])('%s: subject, status text, local date, reference and first name in text and HTML', (_, raw, subject, status) => {
    const email = renderEmail(event(raw), NAME_A);
    const facts = [`Hi ${NAME_A},`, `Status: ${status}`, `Date: ${OCCURRED_DATE_SAST}`, `Dispute reference: ${DISPUTE_A}`];
    expect(email.subject).toBe(subject);
    for (const fact of facts) {
      expect(email.text).toContain(fact);
      expect(email.html).toContain(fact);
    }
    for (const code of RAW_CODES) expect(`${email.subject}\n${email.text}\n${email.html}`).not.toContain(code);
  });

  it.each([
    ['MALWARE', 'it did not pass our security scan'],
    ['TYPE_MISMATCH', 'its contents do not match the type of file it was uploaded as'],
    ['CHECKSUM', 'it is not the same file that was chosen when the upload started'],
    ['SIZE', 'its size is not the size that was given when the upload started'],
    ['SCAN_FAILED', 'we could not finish checking it for viruses'],
  ] as const)('a %s rejection is explained in plain words', (reason, words) => {
    const email = renderEmail(event(rejectedEvent(reason)), NAME_A);
    expect(email.text).toContain(`could not be accepted because ${words}.`);
    expect(email.html).toContain(`could not be accepted because ${words}.`);
  });

  it('HTML-escapes the name so a <script> name cannot inject markup', () => {
    const email = renderEmail(event(statusEvent('DisputeCreated', 'SUBMITTED')), '<script>alert("x")</script>');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;,');
  });

  it('greets neutrally when the name is blank or only control characters', () => {
    expect(renderEmail(event(storedEvent()), ' \u0007\n ').text.startsWith('Hello,\n')).toBe(true);
  });
});
