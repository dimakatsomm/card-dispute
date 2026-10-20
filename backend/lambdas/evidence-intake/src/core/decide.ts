import {
  MAX_EVIDENCE_BYTES,
  type EvidenceContentType,
  type EvidenceRejectionReason,
} from '@cd/dispute-domain';

export type ObservedFacts = {
  readonly sizeBytes: number;
  readonly sha256Hex: string | null;
  readonly contentType: string | null;
  readonly detectedType: EvidenceContentType | null;
};

export type DecideInput =
  | { readonly verdict: 'MALWARE' | 'SCAN_FAILED' }
  | { readonly verdict: 'CLEAN' | 'NOT_SCANNED'; readonly facts: ObservedFacts | 'UNOBSERVABLE' };

export type EvidenceResult =
  | {
      readonly result: 'STORED';
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly contentType: EvidenceContentType;
    }
  | {
      readonly result: 'REJECTED';
      readonly reason: EvidenceRejectionReason;
      readonly sha256?: string;
      readonly sizeBytes?: number;
      readonly contentType?: string;
    };

const rejected = (reason: EvidenceRejectionReason, facts?: ObservedFacts): EvidenceResult => ({
  result: 'REJECTED',
  reason,
  ...(facts?.sha256Hex ? { sha256: facts.sha256Hex } : {}),
  ...(facts && facts.sizeBytes >= 1 ? { sizeBytes: facts.sizeBytes } : {}),
  ...(facts?.contentType ? { contentType: facts.contentType } : {}),
});

const judgeFacts = (facts: ObservedFacts): EvidenceResult => {
  if (facts.detectedType === null || facts.detectedType !== facts.contentType) return rejected('TYPE_MISMATCH', facts);
  if (facts.sizeBytes < 1 || facts.sizeBytes > MAX_EVIDENCE_BYTES) return rejected('SIZE', facts);
  if (facts.sha256Hex === null) return rejected('CHECKSUM', facts);
  return { result: 'STORED', sha256: facts.sha256Hex, sizeBytes: facts.sizeBytes, contentType: facts.detectedType };
};

// The verdict comes only from the scan event; bytes and headers are consulted only once the object is clean.
export const decide = (input: DecideInput): EvidenceResult => {
  switch (input.verdict) {
    case 'MALWARE':
      return rejected('MALWARE');
    case 'SCAN_FAILED':
      return rejected('SCAN_FAILED');
    case 'CLEAN':
    case 'NOT_SCANNED':
      return input.facts === 'UNOBSERVABLE' ? rejected('SCAN_FAILED') : judgeFacts(input.facts);
  }
};
