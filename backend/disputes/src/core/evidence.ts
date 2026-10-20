import { MAX_EVIDENCE_PER_DISPUTE, type EvidenceStatus } from '@cd/dispute-domain';
import type { EvidenceDeclaration, EvidenceRecord } from './types.ts';

export type EvidenceSlot =
  | { readonly kind: 'RESIGN'; readonly record: EvidenceRecord }
  | { readonly kind: 'NEW'; readonly declaration: EvidenceDeclaration };

const CAPPED_STATUSES: ReadonlyArray<EvidenceStatus> = ['PENDING', 'STORED'];

// The file name is deliberately not compared: a renamed retry is still the same bytes (ADR-050).
const sameFile = (a: EvidenceDeclaration, b: EvidenceDeclaration): boolean =>
  a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes && a.contentType === b.contentType;

type Planning = { readonly slots: ReadonlyArray<EvidenceSlot>; readonly matched: ReadonlySet<string> };

export const planEvidenceSlots = (
  existing: ReadonlyArray<EvidenceRecord>,
  declarations: ReadonlyArray<EvidenceDeclaration>,
): ReadonlyArray<EvidenceSlot> =>
  declarations.reduce<Planning>(
    (acc, declaration) => {
      const match = existing.find(
        (e) => e.status === 'PENDING' && !acc.matched.has(e.evidenceId) && sameFile(e, declaration),
      );
      return match === undefined
        ? { slots: [...acc.slots, { kind: 'NEW', declaration }], matched: acc.matched }
        : {
            slots: [...acc.slots, { kind: 'RESIGN', record: match }],
            matched: new Set([...acc.matched, match.evidenceId]),
          };
    },
    { slots: [], matched: new Set() },
  ).slots;

export const newDeclarations = (slots: ReadonlyArray<EvidenceSlot>): ReadonlyArray<EvidenceDeclaration> =>
  slots.flatMap((s) => (s.kind === 'NEW' ? [s.declaration] : []));

export const exceedsEvidenceCap = (
  existing: ReadonlyArray<EvidenceRecord>,
  slots: ReadonlyArray<EvidenceSlot>,
): boolean =>
  existing.filter((e) => CAPPED_STATUSES.includes(e.status)).length + newDeclarations(slots).length >
  MAX_EVIDENCE_PER_DISPUTE;

// `inserted` is in the order newDeclarations(slots) returned, so NEW slots consume it front to back.
export const slotRecords = (
  slots: ReadonlyArray<EvidenceSlot>,
  inserted: ReadonlyArray<EvidenceRecord>,
): ReadonlyArray<EvidenceRecord> =>
  slots.reduce<{ readonly records: ReadonlyArray<EvidenceRecord>; readonly next: number }>(
    (acc, slot) => {
      if (slot.kind === 'RESIGN') return { records: [...acc.records, slot.record], next: acc.next };
      const record = inserted[acc.next];
      if (record === undefined) throw new Error('fewer inserted evidence rows than NEW slots');
      return { records: [...acc.records, record], next: acc.next + 1 };
    },
    { records: [], next: 0 },
  ).records;
