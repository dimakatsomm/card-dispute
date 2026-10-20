import type { DisputeEvent, DisputeStatus, EvidenceRejectionReason } from '@cd/dispute-domain';
import { assertNever } from '@cd/shared/fp';

export type EmailContent = { readonly subject: string; readonly text: string; readonly html: string };

type Message = { readonly subject: string; readonly status: string; readonly paragraphs: ReadonlyArray<string> };

const STATUS_TEXT: Readonly<Record<DisputeStatus, string>> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  RESOLVED_ACCEPTED: 'Resolved in your favour',
  RESOLVED_REJECTED: 'Resolved: declined',
  WITHDRAWN: 'Withdrawn',
};

const STATUS_CHANGE: Readonly<Record<DisputeStatus, Pick<Message, 'subject' | 'paragraphs'>>> = {
  SUBMITTED: {
    subject: 'Your dispute has been submitted',
    paragraphs: ['Your dispute has been submitted and is waiting for one of our agents to review it.'],
  },
  UNDER_REVIEW: {
    subject: 'Your dispute is under review',
    paragraphs: ['One of our agents has started reviewing your dispute.'],
  },
  RESOLVED_ACCEPTED: {
    subject: 'Your dispute was resolved in your favour',
    paragraphs: ['We have reviewed your dispute and resolved it in your favour.'],
  },
  RESOLVED_REJECTED: {
    subject: 'Your dispute has been resolved',
    paragraphs: ['We have reviewed your dispute and were unable to uphold it.', 'You can read the outcome in the app.'],
  },
  WITHDRAWN: {
    subject: 'Your dispute has been withdrawn',
    paragraphs: ['Your dispute has been withdrawn. We will take no further action on it.'],
  },
};

const REJECTION_TEXT: Readonly<Record<EvidenceRejectionReason, string>> = {
  MALWARE: 'it did not pass our security scan',
  TYPE_MISMATCH: 'its contents do not match the type of file it was uploaded as',
  CHECKSUM: 'it is not the same file that was chosen when the upload started',
  SIZE: 'its size is not the size that was given when the upload started',
  SCAN_FAILED: 'we could not finish checking it for viruses',
};

const message = (event: DisputeEvent): Message => {
  switch (event.eventType) {
    case 'DisputeCreated':
      return {
        subject: 'We have received your dispute',
        status: STATUS_TEXT[event.data.toStatus],
        paragraphs: ['Thank you. We have received your dispute and it is waiting for one of our agents to review it.'],
      };
    case 'DisputeEdited':
      return {
        subject: 'Your dispute has been updated',
        status: STATUS_TEXT[event.data.toStatus],
        paragraphs: ['The changes to your dispute have been saved.'],
      };
    case 'DisputeStatusChanged':
      return { ...STATUS_CHANGE[event.data.toStatus], status: STATUS_TEXT[event.data.toStatus] };
    case 'EvidenceStored':
      return {
        subject: 'Your evidence has been added',
        status: 'Evidence added',
        paragraphs: ['A file you uploaded passed our checks and has been added to your dispute.'],
      };
    case 'EvidenceRejected':
      return {
        subject: 'We could not accept a file you uploaded',
        status: 'Evidence not accepted',
        paragraphs: [
          `A file you uploaded to your dispute could not be accepted because ${REJECTION_TEXT[event.data.evidence.reason]}.`,
          'You can upload a replacement in the app while your dispute is open.',
        ],
      };
    default:
      return assertNever(event);
  }
};

// Customers are in South Africa (no daylight saving), so the date matches their calendar.
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Johannesburg',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export const formatDate = (iso: string): string => DATE_FORMAT.format(new Date(iso));

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);

const greeting = (firstName: string): string => {
  const name = firstName.replace(/\p{Cc}+/gu, ' ').trim();
  return name ? `Hi ${name},` : 'Hello,';
};

const CLOSING: ReadonlyArray<string> = [
  'You can follow your dispute in the app at any time.',
  'This is an automated message. Please do not reply.',
];

export const renderEmail = (event: DisputeEvent, firstName: string): EmailContent => {
  const { subject, status, paragraphs } = message(event);
  const hello = greeting(firstName);
  const facts = [`Status: ${status}`, `Date: ${formatDate(event.occurredAt)}`, `Dispute reference: ${event.disputeId}`];
  const text = [hello, '', ...paragraphs, '', ...facts, '', ...CLOSING].join('\n');
  const html = [
    '<!doctype html><html><body>',
    `<p>${escapeHtml(hello)}</p>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p>${facts.map(escapeHtml).join('<br>')}</p>`,
    ...CLOSING.map((p) => `<p>${escapeHtml(p)}</p>`),
    '</body></html>',
  ].join('\n');
  return { subject, text, html };
};
