import { codePointLength } from '../../components/evidence';
import type { DisputeStatus } from '../disputes/labels';
import type { AgentDispute, DownloadError, Expected } from './api';

export const NOTE_MIN = 10;
export const NOTE_MAX = 2000;

export type NoteProblem = 'TOO_SHORT' | 'TOO_LONG';

export const checkNote = (note: string): NoteProblem | null => {
  const length = codePointLength(note);
  if (length < NOTE_MIN) return 'TOO_SHORT';
  if (length > NOTE_MAX) return 'TOO_LONG';
  return null;
};

// Sent back exactly as read, so the server can refuse a decision made on a stale view (412).
export const expectedFrom = (dispute: Pick<AgentDispute, 'version' | 'evidenceDigest'>): Expected => ({
  expectedVersion: dispute.version,
  expectedEvidenceDigest: dispute.evidenceDigest,
});

export const isOpen = (status: DisputeStatus): boolean => status === 'SUBMITTED' || status === 'UNDER_REVIEW';

export const POPUP_BLOCKED_MESSAGE = 'Your browser blocked the download tab. Allow pop-ups for this site and try again.';

export const downloadErrorMessage = (error: DownloadError): string => {
  switch (error.kind) {
    case 'NOT_FOUND':
      return 'This file could not be found. The evidence list has been refreshed.';
    case 'NOT_STORED':
      return "This file isn't available to download.";
    case 'RATE_LIMITED':
      return error.retryAfterSeconds === null
        ? 'Too many downloads — try again shortly.'
        : `Too many downloads — try again in ${error.retryAfterSeconds} s`;
    case 'UNAVAILABLE':
      return 'Download is unavailable right now.';
  }
};
