import { describe, expect, it } from 'vitest';
import { enrich, type Enrichment } from '../../src/core/disputable.ts';
import type { Transaction } from '../../src/core/transaction.ts';

const NOW = new Date('2026-10-19T12:00:00Z');

const txn: Transaction = {
  transactionId: 't-1',
  accountId: 'a-1',
  cardId: 'c-1',
  amount: '10.00',
  currency: 'ZAR',
  merchantName: 'Fake',
  mcc: null,
  type: 'PURCHASE',
  status: 'POSTED',
  transactionAt: '2026-10-10T10:00:00.000000Z',
  postedAt: '2026-10-10T10:00:00.000000Z',
};

const validCard = { cardId: 'c-1', expiryMonth: 12, expiryYear: 2099, status: 'ACTIVE' as const };

describe('enrich', () => {
  it.each<[string, Enrichment | null, unknown]>([
    ['enrichment unavailable', null, { dispute: null, disputable: { allowed: false, reason: 'UNAVAILABLE' } }],
    [
      'card missing, no dispute → UNAVAILABLE (fails closed)',
      { cards: [], disputes: [] },
      { dispute: null, disputable: { allowed: false, reason: 'UNAVAILABLE' } },
    ],
    [
      'card missing, dispute exists → ALREADY_DISPUTED (rule 1 needs no card)',
      { cards: [], disputes: [{ transactionId: 't-1', disputeId: 'd-1', status: 'SUBMITTED' }] },
      { dispute: { disputeId: 'd-1', status: 'SUBMITTED' }, disputable: { allowed: false, reason: 'ALREADY_DISPUTED' } },
    ],
    ['eligible', { cards: [validCard], disputes: [] }, { dispute: null, disputable: { allowed: true } }],
  ])('%s', (_name, enrichment, expected) => {
    expect(enrich([txn], enrichment, NOW)[0]).toMatchObject(expected as object);
  });
});
