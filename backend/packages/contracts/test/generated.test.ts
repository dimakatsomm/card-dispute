import {
  DISPUTE_STATUSES,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_REJECTION_REASONS,
  EVIDENCE_STATUSES,
  MAX_EVIDENCE_BYTES,
  REASON_CODES,
  TRANSACTION_STATUSES,
} from '@cd/dispute-domain';
import { describe, expect, it } from 'vitest';
import {
  zCreateDisputeRequest,
  zDisputeStatus,
  zEvidence,
  zEvidenceDeclaration,
  zListMyDisputesResponse,
  zReasonCode,
  zTimestamp,
  zUpdateDisputeBody,
  zUuid,
} from '../src/disputes.public/zod.ts';
import { zEvidenceRejected, zEvidenceStored } from '../src/disputes.service/zod.ts';
import { zTransactionStatus } from '../src/transactions.public/zod.ts';

describe('generator rules', () => {
  it.each([
    ['disputedAmount', { action: 'EDIT', disputedAmount: '1.00' }],
    ['note', { action: 'EDIT', note: 'x' }],
  ])('rejects EDIT carrying %s (strictObject)', (_name, body) => {
    expect(zUpdateDisputeBody.safeParse(body).success).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(zUpdateDisputeBody.safeParse({ action: 'DELETE' }).success).toBe(false);
  });

  it('accepts a valid WITHDRAW', () => {
    expect(zUpdateDisputeBody.safeParse({ action: 'WITHDRAW' }).success).toBe(true);
  });

  it('rejects a missing required-nullable field', () => {
    expect(zListMyDisputesResponse.safeParse({ items: [] }).success).toBe(false);
    expect(zListMyDisputesResponse.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('accepts non-RFC uuids from seeds', () => {
    expect(zUuid.safeParse('00000000-0000-0000-0000-000000000001').success).toBe(true);
  });

  it('accepts datetimes with an offset', () => {
    expect(zTimestamp.safeParse('2026-10-20T10:00:00+02:00').success).toBe(true);
  });

  it.each([
    ['10 emoji', '😀'.repeat(10), true],
    ['9 emoji', '😀'.repeat(9), false],
    ['2000 emoji', '😀'.repeat(2000), true],
    ['2001 emoji', '😀'.repeat(2001), false],
    ['9 ASCII characters', 'a'.repeat(9), false],
  ])('counts description length in code points: %s', (_name, description, ok) => {
    const result = zCreateDisputeRequest.safeParse({ reasonCode: REASON_CODES[0], description });
    expect(result.success).toBe(ok);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual(['description']);
    }
  });

  it.each([
    ['1 MiB of ASCII', 'a'.repeat(1024 * 1024)],
    ['1 MiB of emoji', '😀'.repeat(512 * 1024)],
  ])('rejects an oversized description without a slow spread: %s', (_name, description) => {
    const started = performance.now();
    const result = zCreateDisputeRequest.safeParse({ reasonCode: REASON_CODES[0], description });
    expect(result.success).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('evidence declaration bounds', () => {
  const declaration = {
    fileName: 'statement.pdf',
    contentType: 'application/pdf',
    sizeBytes: 183422,
    sha256: 'a'.repeat(64),
  };

  it.each([
    ['sizeBytes 0', { sizeBytes: 0 }, false],
    ['sizeBytes at the 10 MiB limit', { sizeBytes: 10485760 }, true],
    ['sizeBytes one over the limit', { sizeBytes: 10485761 }, false],
    ['contentType outside the allow-list', { contentType: 'text/html' }, false],
    ['uppercase sha256', { sha256: 'A'.repeat(64) }, false],
    ['63-char sha256', { sha256: 'a'.repeat(63) }, false],
    ['fileName with a control character', { fileName: 'a\u0000b.pdf' }, false],
    ['fileName with a DEL-range control character', { fileName: 'a\u0085b.pdf' }, false],
    ['fileName of 255 code points', { fileName: '😀'.repeat(255) }, true],
    ['fileName of 256 code points', { fileName: '😀'.repeat(256) }, false],
  ])('%s', (_name, override, ok) => {
    const result = zCreateDisputeRequest.safeParse({
      reasonCode: REASON_CODES[0],
      description: 'a valid description',
      evidence: [{ ...declaration, ...override }],
    });
    expect(result.success).toBe(ok);
  });
});

describe('enums match dispute-domain (single source of truth)', () => {
  it('evidence content types', () => {
    expect([...zEvidenceDeclaration.shape.contentType.options]).toEqual([...EVIDENCE_CONTENT_TYPES]);
    expect([...zEvidence.shape.contentType.options]).toEqual([...EVIDENCE_CONTENT_TYPES]);
    expect([...zEvidenceStored.shape.contentType.options]).toEqual([...EVIDENCE_CONTENT_TYPES]);
  });
  it('evidence statuses', () => {
    expect([...zEvidence.shape.status.options]).toEqual([...EVIDENCE_STATUSES]);
  });
  it('evidence rejection reasons', () => {
    expect([...zEvidence.shape.rejectionReason.unwrap().options]).toEqual([...EVIDENCE_REJECTION_REASONS]);
    expect([...zEvidenceRejected.shape.reason.options]).toEqual([...EVIDENCE_REJECTION_REASONS]);
  });
  it('evidence size limit', () => {
    expect(zEvidenceDeclaration.shape.sizeBytes.safeParse(MAX_EVIDENCE_BYTES).success).toBe(true);
    expect(zEvidenceDeclaration.shape.sizeBytes.safeParse(MAX_EVIDENCE_BYTES + 1).success).toBe(false);
  });
  it('reason codes', () => {
    expect([...zReasonCode.options]).toEqual([...REASON_CODES]);
  });
  it('dispute statuses', () => {
    expect([...zDisputeStatus.options]).toEqual([...DISPUTE_STATUSES]);
  });
  it('transaction statuses', () => {
    expect([...zTransactionStatus.options]).toEqual([...TRANSACTION_STATUSES]);
  });
});
