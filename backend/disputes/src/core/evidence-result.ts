import type { EvidenceContentType, EvidenceRejectionReason, EvidenceStatus } from '@cd/dispute-domain';
import { assertNever } from '@cd/shared/fp';
import type { EvidenceDeclaration } from './types.ts';

export type ReportedFacts = {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: EvidenceContentType;
};

export type ReportedResult =
  | ({ readonly result: 'STORED' } & ReportedFacts)
  | { readonly result: 'REJECTED'; readonly reason: EvidenceRejectionReason };

export type EvidenceOutcome =
  { readonly status: 'STORED' } | { readonly status: 'REJECTED'; readonly reason: EvidenceRejectionReason };

export type Settlement = 'APPLY' | 'NO_OP' | 'EVIDENCE_CLOSED' | 'RESULT_CONFLICT';

type Declared = Pick<EvidenceDeclaration, 'sha256' | 'sizeBytes' | 'contentType'>;

// Type first, so a disguised executable reads as TYPE_MISMATCH even when its size differs as well.
const factMismatch = (declared: Declared, reported: ReportedFacts): EvidenceRejectionReason | null => {
  if (reported.contentType !== declared.contentType) return 'TYPE_MISMATCH';
  if (reported.sizeBytes !== declared.sizeBytes) return 'SIZE';
  if (reported.sha256 !== declared.sha256) return 'CHECKSUM';
  return null;
};

export const decideOutcome = (declared: Declared, reported: ReportedResult): EvidenceOutcome => {
  if (reported.result === 'REJECTED') return { status: 'REJECTED', reason: reported.reason };
  const reason = factMismatch(declared, reported);
  return reason === null ? { status: 'STORED' } : { status: 'REJECTED', reason };
};

// A repeat is matched on status only: the first recorded reason stands, as intake may word a retry differently.
export const settlementOf = (current: EvidenceStatus, outcome: EvidenceOutcome): Settlement => {
  switch (current) {
    case 'PENDING':
      return 'APPLY';
    case 'EXPIRED':
    case 'ERASED':
      return 'EVIDENCE_CLOSED';
    case 'STORED':
    case 'REJECTED':
      return current === outcome.status ? 'NO_OP' : 'RESULT_CONFLICT';
    default:
      return assertNever(current);
  }
};
