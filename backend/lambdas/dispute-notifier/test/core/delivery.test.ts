import { parseDisputeEvent, type DisputeEvent } from '@cd/dispute-domain';
import { describe, expect, it } from 'vitest';
import { decideDelivery, type Delivery } from '../../src/core/delivery.ts';
import { DISPUTE_A, TXN_A, rejectedEvent, statusEvent, storedEvent } from '../support.ts';

const event = (raw: unknown): DisputeEvent => {
  const parsed = parseDisputeEvent(raw);
  if (!parsed.ok) throw new Error(parsed.error.issues.join('; '));
  return parsed.value;
};

const owned = (version: number, overrides: Partial<{ disputeId: string; transactionId: string }> = {}) => [
  { disputeId: DISPUTE_A, transactionId: TXN_A, version, ...overrides },
];

const OTHER = '9f9f9f9f-0000-4000-8000-000000000001';

describe('decideDelivery', () => {
  it.each<[string, unknown, ReturnType<typeof owned>, Delivery]>([
    ['Created, current version', statusEvent('DisputeCreated', 'SUBMITTED', 1), owned(1), { kind: 'SEND' }],
    ['Created, older than current', statusEvent('DisputeCreated', 'SUBMITTED', 1), owned(2), { kind: 'SKIP_STALE', currentVersion: 2 }],
    ['Edited, older than current', statusEvent('DisputeEdited', 'SUBMITTED', 2), owned(3), { kind: 'SKIP_STALE', currentVersion: 3 }],
    ['StatusChanged, older than current', statusEvent('DisputeStatusChanged', 'UNDER_REVIEW', 2), owned(4), { kind: 'SKIP_STALE', currentVersion: 4 }],
    ['StatusChanged, current version', statusEvent('DisputeStatusChanged', 'WITHDRAWN', 4), owned(4), { kind: 'SEND' }],
    ['StatusChanged, newer than lookup', statusEvent('DisputeStatusChanged', 'WITHDRAWN', 5), owned(4), { kind: 'SEND' }],
    ['EvidenceStored, older than current', storedEvent(1), owned(9), { kind: 'SEND' }],
    ['EvidenceRejected, older than current', rejectedEvent('SCAN_FAILED', 1), owned(9), { kind: 'SEND' }],
    ['dispute absent for the user', statusEvent('DisputeCreated', 'SUBMITTED', 1), [], { kind: 'DISPUTE_ABSENT' }],
    ['other dispute on the transaction', storedEvent(1), owned(1, { disputeId: OTHER }), { kind: 'DISPUTE_ABSENT' }],
    ['dispute under another transaction', storedEvent(1), owned(1, { transactionId: OTHER }), { kind: 'DISPUTE_ABSENT' }],
  ])('%s', (_, raw, lookup, expected) => {
    expect(decideDelivery(event(raw), lookup)).toEqual(expected);
  });
});
