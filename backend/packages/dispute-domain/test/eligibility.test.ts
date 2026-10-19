import { err, ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import {
  DISPUTABLE_TRANSACTION_TYPES,
  DISPUTE_STATUSES,
  REASON_CODES,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
  evaluateTransactionEligibility,
  isCardExpired,
  type EligibilityCard,
  type EligibilityTransaction,
  type ExistingDispute,
  type ExpiringCard,
} from '../src/index.ts';

describe('REASON_CODES', () => {
  it('is exactly the seven docs/04 codes', () => {
    expect(REASON_CODES).toEqual([
      'FRAUD',
      'NOT_RECEIVED',
      'DUPLICATE',
      'INCORRECT_AMOUNT',
      'CANCELLED_SUBSCRIPTION',
      'DEFECTIVE_GOODS',
      'OTHER',
    ]);
  });
});

describe('exported rule data is frozen at runtime', () => {
  const rows: ReadonlyArray<{ name: string; value: object }> = [
    { name: 'REASON_CODES', value: REASON_CODES },
    { name: 'DISPUTE_STATUSES', value: DISPUTE_STATUSES },
    { name: 'TERMINAL_STATUSES', value: TERMINAL_STATUSES },
    { name: 'DISPUTABLE_TRANSACTION_TYPES', value: DISPUTABLE_TRANSACTION_TYPES },
    { name: 'TRANSITION_TABLE', value: TRANSITION_TABLE },
    ...TRANSITION_TABLE.flatMap((row, i) => [
      { name: `TRANSITION_TABLE[${i}]`, value: row },
      { name: `TRANSITION_TABLE[${i}].from`, value: row.from },
    ]),
  ];

  it.each(rows)('$name', ({ value }) => {
    expect(Object.isFrozen(value)).toBe(true);
  });
});

describe('isCardExpired', () => {
  const rows: ReadonlyArray<{ name: string; card: ExpiringCard; now: string; expired: boolean }> = [
    { name: '09/2028 valid at last instant of September', card: { expiryMonth: 9, expiryYear: 2028 }, now: '2028-09-30T23:59:59.999Z', expired: false },
    { name: '09/2028 expired at first instant of October', card: { expiryMonth: 9, expiryYear: 2028 }, now: '2028-10-01T00:00:00.000Z', expired: true },
    { name: '12/2028 valid at last instant of the year', card: { expiryMonth: 12, expiryYear: 2028 }, now: '2028-12-31T23:59:59.999Z', expired: false },
    { name: '12/2028 expired at first instant of next year', card: { expiryMonth: 12, expiryYear: 2028 }, now: '2029-01-01T00:00:00.000Z', expired: true },
    { name: '02/2028 valid on leap day', card: { expiryMonth: 2, expiryYear: 2028 }, now: '2028-02-29T23:59:59.999Z', expired: false },
    { name: 'fails closed: invalid now', card: { expiryMonth: 12, expiryYear: 2030 }, now: 'not-a-date', expired: true },
    { name: 'fails closed: month out of range', card: { expiryMonth: 13, expiryYear: 2028 }, now: '2028-12-01T00:00:00.000Z', expired: true },
    { name: 'fails closed: non-integer month', card: { expiryMonth: 9.5, expiryYear: 2028 }, now: '2028-09-15T00:00:00.000Z', expired: true },
    { name: 'fails closed: year out of range', card: { expiryMonth: 12, expiryYear: 2101 }, now: '2028-09-15T00:00:00.000Z', expired: true },
    { name: 'fails closed: non-integer year', card: { expiryMonth: 12, expiryYear: 2028.5 }, now: '2028-09-15T00:00:00.000Z', expired: true },
  ];

  it.each(rows)('$name', ({ card, now, expired }) => {
    expect(isCardExpired(card, new Date(now))).toBe(expired);
  });
});

describe('evaluateTransactionEligibility', () => {
  const NOW = '2026-10-19T12:00:00.000Z';
  const txn: EligibilityTransaction = { type: 'PURCHASE', status: 'POSTED', postedAt: new Date('2026-10-01T09:00:00Z') };
  const card: EligibilityCard = { expiryMonth: 12, expiryYear: 2030, status: 'ACTIVE' };
  const expiredCard: EligibilityCard = { expiryMonth: 9, expiryYear: 2026, status: 'ACTIVE' };
  const pending: EligibilityTransaction = { type: 'PURCHASE', status: 'PENDING', postedAt: null };
  const oldRefund: EligibilityTransaction = { type: 'REFUND', status: 'POSTED', postedAt: new Date('2025-01-01T00:00:00Z') };

  const rows: ReadonlyArray<{
    name: string;
    txn?: EligibilityTransaction;
    card?: EligibilityCard;
    existing?: ExistingDispute;
    now?: string;
    expected: ReturnType<typeof evaluateTransactionEligibility>;
  }> = [
    { name: 'eligible PURCHASE', expected: ok(true) },
    { name: 'eligible ATM_WITHDRAWAL', txn: { ...txn, type: 'ATM_WITHDRAWAL' }, expected: ok(true) },
    { name: 'eligible FEE', txn: { ...txn, type: 'FEE' }, expected: ok(true) },
    { name: 'rule 1: existing SUBMITTED dispute', existing: { status: 'SUBMITTED' }, expected: err('ALREADY_DISPUTED') },
    { name: 'rule 1: existing WITHDRAWN dispute still blocks', existing: { status: 'WITHDRAWN' }, expected: err('ALREADY_DISPUTED') },
    { name: 'rule 1 wins when every rule fails', existing: { status: 'RESOLVED_REJECTED' }, card: expiredCard, txn: { ...oldRefund, status: 'REVERSED' }, expected: err('ALREADY_DISPUTED') },
    { name: 'rule 2: expired card', card: expiredCard, expected: err('CARD_EXPIRED') },
    { name: 'fails closed: invalid now is CARD_EXPIRED', now: 'not-a-date', expected: err('CARD_EXPIRED') },
    { name: 'rule 2 before rule 3: expired card and PENDING txn', card: expiredCard, txn: pending, expected: err('CARD_EXPIRED') },
    { name: 'BLOCKED card alone does not block', card: { ...card, status: 'BLOCKED' }, expected: ok(true) },
    { name: 'CANCELLED card alone does not block', card: { ...card, status: 'CANCELLED' }, expected: ok(true) },
    { name: 'rule 3: PENDING', txn: pending, expected: err('TXN_NOT_POSTED') },
    { name: 'rule 3: DECLINED', txn: { ...txn, status: 'DECLINED' }, expected: err('TXN_NOT_POSTED') },
    { name: 'rule 3: REVERSED', txn: { ...txn, status: 'REVERSED' }, expected: err('TXN_NOT_POSTED') },
    { name: 'fails closed: POSTED with invalid postedAt', txn: { ...txn, postedAt: new Date('not-a-date') }, expected: err('TXN_NOT_POSTED') },
    { name: 'rule 3 before rule 4: PENDING REFUND', txn: { ...pending, type: 'REFUND' }, expected: err('TXN_NOT_POSTED') },
    { name: 'rule 4: REFUND', txn: { ...txn, type: 'REFUND' }, expected: err('TXN_TYPE_NOT_DISPUTABLE') },
    { name: 'rule 4 before rule 5: REFUND outside window', txn: oldRefund, expected: err('TXN_TYPE_NOT_DISPUTABLE') },
    { name: 'rule 5: posted 120 days ago is inside', txn: { ...txn, postedAt: new Date('2026-06-21T12:00:00Z') }, expected: ok(true) },
    { name: 'rule 5: posted 121 days ago is outside', txn: { ...txn, postedAt: new Date('2026-06-20T12:00:00Z') }, expected: err('OUTSIDE_WINDOW') },
    { name: 'rule 5: whole UTC days, day 120 at 23:59:59.999 is inside', txn: { ...txn, postedAt: new Date('2026-06-21T00:00:00.000Z') }, now: '2026-10-19T23:59:59.999Z', expected: ok(true) },
    { name: 'rule 5: whole UTC days, day 121 at 00:00 is outside', txn: { ...txn, postedAt: new Date('2026-06-20T23:59:59.999Z') }, now: '2026-10-19T00:00:00.000Z', expected: err('OUTSIDE_WINDOW') },
    { name: 'fails closed: postedAt later than now, even on the same day', txn: { ...txn, postedAt: new Date('2026-10-19T13:00:00Z') }, expected: err('OUTSIDE_WINDOW') },
  ];

  it.each(rows)('$name', (row) => {
    expect(
      evaluateTransactionEligibility(row.txn ?? txn, row.card ?? card, row.existing ?? null, new Date(row.now ?? NOW)),
    ).toEqual(row.expected);
  });
});
