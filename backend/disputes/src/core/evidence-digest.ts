import type { EvidenceRecord } from './types.ts';

export type DigestInput = Pick<EvidenceRecord, 'evidenceId' | 'status'>;

// Sorted, so the detail read and the locked re-read agree whatever order the rows come back in.
export const canonicalEvidence = (evidence: ReadonlyArray<DigestInput>): string =>
  [...evidence]
    .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0))
    .map((e) => `${e.evidenceId}:${e.status}\n`)
    .join('');
