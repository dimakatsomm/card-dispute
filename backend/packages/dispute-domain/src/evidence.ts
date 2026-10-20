export const EVIDENCE_CONTENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png'] as const);
export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

export const EVIDENCE_STATUSES = Object.freeze(['PENDING', 'STORED', 'REJECTED', 'EXPIRED', 'ERASED'] as const);
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_REJECTION_REASONS = Object.freeze(['MALWARE', 'TYPE_MISMATCH', 'CHECKSUM', 'SIZE', 'SCAN_FAILED'] as const);
export type EvidenceRejectionReason = (typeof EVIDENCE_REJECTION_REASONS)[number];

export const MAX_EVIDENCE_BYTES = 10_485_760;
export const MAX_EVIDENCE_PER_DISPUTE = 5;
export const UPLOAD_URL_TTL_SECONDS = 600;
export const ERASED_TEXT = '[erased]';

const SIGNATURES: ReadonlyArray<{ readonly type: EvidenceContentType; readonly magic: ReadonlyArray<number> }> =
  Object.freeze([
    { type: 'application/pdf', magic: Object.freeze([0x25, 0x50, 0x44, 0x46, 0x2d]) },
    { type: 'image/jpeg', magic: Object.freeze([0xff, 0xd8, 0xff]) },
    { type: 'image/png', magic: Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ]);

export const EVIDENCE_SNIFF_BYTES = Math.max(...SIGNATURES.map((s) => s.magic.length));

const startsWith = (head: Uint8Array, magic: ReadonlyArray<number>): boolean =>
  head.length >= magic.length && magic.every((byte, i) => head[i] === byte);

export const detectEvidenceType = (head: Uint8Array): EvidenceContentType | null =>
  SIGNATURES.find((s) => startsWith(head, s.magic))?.type ?? null;
