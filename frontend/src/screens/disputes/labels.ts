import type { components } from '../../api/generated/disputes';
import type { ReasonCode } from '../../lib/dispute-reasons';

type Schemas = components['schemas'];
export type DisputeStatus = Schemas['DisputeStatus'];
export type { ReasonCode };
export type TimelineType = Schemas['TimelineType'];
export type TimelineActor = Schemas['TimelineEvent']['by'];
export type EvidenceStatus = Schemas['Evidence']['status'];
export type RejectionReason = NonNullable<Schemas['Evidence']['rejectionReason']>;
export type TransactionRef = Schemas['TransactionRef'];

export const DISPUTE_STATUSES: ReadonlyArray<DisputeStatus> = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'RESOLVED_ACCEPTED',
  'RESOLVED_REJECTED',
  'WITHDRAWN',
];

export const statusLabel: Readonly<Record<DisputeStatus, string>> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  RESOLVED_ACCEPTED: 'Resolved in your favour',
  RESOLVED_REJECTED: 'Resolved: declined',
  WITHDRAWN: 'Withdrawn',
};

export const reasonLabel: Readonly<Record<ReasonCode, string>> = {
  FRAUD: 'Fraud',
  NOT_RECEIVED: 'Goods or service not received',
  DUPLICATE: 'Duplicate charge',
  INCORRECT_AMOUNT: 'Incorrect amount',
  CANCELLED_SUBSCRIPTION: 'Cancelled subscription',
  DEFECTIVE_GOODS: 'Defective goods',
  OTHER: 'Other',
};

export const timelineLabel: Readonly<Record<TimelineType, string>> = {
  SUBMITTED: 'Dispute submitted',
  EDITED: 'Dispute edited',
  EVIDENCE_ADDED: 'Evidence added',
  EVIDENCE_REJECTED: 'Evidence rejected',
  UNDER_REVIEW: 'Review started',
  RESOLVED_ACCEPTED: 'Resolved in your favour',
  RESOLVED_REJECTED: 'Resolved: declined',
  WITHDRAWN: 'Dispute withdrawn',
};

export const actorLabel: Readonly<Record<TimelineActor, string>> = {
  CUSTOMER: 'You',
  BANK: 'The bank',
};

export const evidenceStatusLabel: Readonly<Record<EvidenceStatus, string>> = {
  PENDING: 'Scanning',
  STORED: 'Stored',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired (not uploaded in time)',
  ERASED: 'Removed',
};

export const rejectionReasonLabel: Readonly<Record<RejectionReason, string>> = {
  MALWARE: 'the file failed the security scan',
  TYPE_MISMATCH: 'the file contents do not match its type',
  CHECKSUM: 'the file does not match what was declared',
  SIZE: 'the file size does not match what was declared',
  SCAN_FAILED: 'we could not complete the security scan, please upload it again',
};

const isRejectionReason = (value: string): value is RejectionReason => value in rejectionReasonLabel;

export const describeRejection = (reason: string | undefined): string =>
  reason && isRejectionReason(reason) ? rejectionReasonLabel[reason] : 'the file could not be accepted';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatDateTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
};
