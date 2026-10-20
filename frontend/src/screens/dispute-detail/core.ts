import { evidenceStatusLabel, statusLabel, type DisputeStatus } from '../disputes/labels';
import type { DisputeDetail, Evidence } from './api';

export const ERASED_TEXT = '[erased]';

export const POLL_INTERVAL_MS = 3000;
export const MAX_POLLS = 20;

export const isOpen = (status: DisputeStatus): boolean => status === 'SUBMITTED' || status === 'UNDER_REVIEW';

export const isResolved = (status: DisputeStatus): boolean =>
  status === 'RESOLVED_ACCEPTED' || status === 'RESOLVED_REJECTED';

export const isErased = (dispute: Pick<DisputeDetail, 'description'>): boolean => dispute.description === ERASED_TEXT;

export const visibleText = (value: string | null | undefined): string | null =>
  value && value !== ERASED_TEXT ? value : null;

export const hasPendingEvidence = (evidence: ReadonlyArray<Evidence>): boolean =>
  evidence.some((item) => item.status === 'PENDING');

export const pollDelay = (input: { readonly pending: boolean; readonly polls: number }): number | false =>
  input.pending && input.polls < MAX_POLLS ? POLL_INTERVAL_MS : false;

export const isStillChecking = (input: { readonly pending: boolean; readonly polls: number }): boolean =>
  input.pending && input.polls >= MAX_POLLS;

type Snapshot = Pick<DisputeDetail, 'status' | 'evidence'>;

const evidenceName = (item: Evidence): string => visibleText(item.fileName) ?? 'A file';

export const describeChanges = (previous: Snapshot, next: Snapshot): string | null => {
  const before = new Map(previous.evidence.map((item) => [item.evidenceId, item.status]));
  const messages = [
    ...(previous.status !== next.status ? [`Dispute status is now ${statusLabel[next.status]}.`] : []),
    ...next.evidence
      .filter((item) => before.has(item.evidenceId) && before.get(item.evidenceId) !== item.status)
      .map((item) => `${evidenceName(item)}: ${evidenceStatusLabel[item.status]}.`),
  ];
  return messages.length > 0 ? messages.join(' ') : null;
};
