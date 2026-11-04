import { codePointLength } from '../../components/evidence';
import type { DisputeStatus } from '../disputes/labels';
import type { AgentDispute, Expected } from './api';

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
