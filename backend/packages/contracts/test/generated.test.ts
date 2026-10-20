import { DISPUTE_STATUSES, REASON_CODES, TRANSACTION_STATUSES } from '@cd/dispute-domain';
import { describe, expect, it } from 'vitest';
import {
  zDisputeStatus,
  zListMyDisputesResponse,
  zReasonCode,
  zTimestamp,
  zUpdateDisputeBody,
  zUuid,
} from '../src/disputes.public/zod.ts';
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
});

describe('enums match dispute-domain (single source of truth)', () => {
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
