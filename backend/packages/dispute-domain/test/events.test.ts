import { describe, expect, it } from 'vitest';
import { isStaleEvent, parseDisputeEvent, type DisputeEvent, type EventType } from '../src/index.ts';

const envelope = {
  eventId: '0b5d2f4e-9a1c-4e7b-8f3a-2c6d1e0f9a8b',
  occurredAt: '2026-10-20T10:00:00.000Z',
  disputeId: '1c6e3a5f-0b2d-4f8c-9a4b-3d7e2f1a0b9c',
  transactionId: '00000000-0000-0000-0000-000000000001',
  userId: '2d7f4b6a-1c3e-4a9d-8b5c-4e8f3a2b1c0d',
  version: 3,
};

const statusData = { fromStatus: 'SUBMITTED', toStatus: 'UNDER_REVIEW', reasonCode: 'FRAUD' };
const evidenceId = '3e8a5c7b-2d4f-4b0e-9c6d-5f9a4b3c2d1e';

const valid: Readonly<Record<EventType, Record<string, unknown>>> = {
  DisputeCreated: {
    ...envelope,
    eventType: 'DisputeCreated',
    version: 1,
    data: { fromStatus: null, toStatus: 'SUBMITTED', reasonCode: 'FRAUD' },
  },
  DisputeEdited: { ...envelope, eventType: 'DisputeEdited', data: { ...statusData, fromStatus: 'SUBMITTED', toStatus: 'SUBMITTED' } },
  DisputeStatusChanged: { ...envelope, eventType: 'DisputeStatusChanged', data: statusData },
  EvidenceStored: { ...envelope, eventType: 'EvidenceStored', data: { evidence: { evidenceId } } },
  EvidenceRejected: {
    ...envelope,
    eventType: 'EvidenceRejected',
    data: { evidence: { evidenceId, reason: 'TYPE_MISMATCH' } },
  },
};

const parsed = (input: Record<string, unknown>): DisputeEvent => {
  const result = parseDisputeEvent(input);
  if (!result.ok) throw new Error(`fixture did not parse: ${result.error.issues.join(', ')}`);
  return result.value;
};

describe('parseDisputeEvent accepts every event type', () => {
  it.each(Object.entries(valid))('%s', (_type, event) => {
    expect(parseDisputeEvent(event)).toEqual({ ok: true, value: event });
  });

  it.each([
    ['an offset occurredAt', { occurredAt: '2026-10-20T12:00:00+02:00' }],
    ['a seeded non-RFC uuid', { userId: '00000000-0000-0000-0000-000000000002' }],
  ])('accepts %s', (_name, override) => {
    expect(parseDisputeEvent({ ...valid.DisputeStatusChanged, ...override }).ok).toBe(true);
  });

  it('accepts EvidenceRejected with SCAN_FAILED', () => {
    expect(parseDisputeEvent({ ...valid.EvidenceRejected, data: { evidence: { evidenceId, reason: 'SCAN_FAILED' } } }).ok).toBe(true);
  });
});

const without = (event: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(event).filter(([k]) => k !== key));

const status = valid.DisputeStatusChanged;
const stored = valid.EvidenceStored;
const rejected = valid.EvidenceRejected;

describe('parseDisputeEvent rejects', () => {
  it.each<[string, unknown]>([
    ['an unknown eventType', { ...status, eventType: 'DisputeDeleted' }],
    ['the retired EvidenceUploaded', { ...stored, eventType: 'EvidenceUploaded' }],
    ['a missing version', without(status, 'version')],
    ['version 0', { ...status, version: 0 }],
    ['a fractional version', { ...status, version: 1.5 }],
    ['a string version', { ...status, version: '3' }],
    ['a non-uuid eventId', { ...status, eventId: 'evt-1' }],
    ['a non-uuid disputeId', { ...status, disputeId: '42' }],
    ['a non-uuid transactionId', { ...status, transactionId: 'not-a-uuid' }],
    ['a non-uuid userId', { ...status, userId: 'user@example.com' }],
    ['a non-uuid evidenceId', { ...stored, data: { evidence: { evidenceId: 'receipt.pdf' } } }],
    ['a non-ISO occurredAt', { ...status, occurredAt: '20/10/2026' }],
    ['a missing occurredAt', without(status, 'occurredAt')],
    ['top-level email', { ...status, email: 'a@example.com' }],
    ['top-level to', { ...status, to: 'a@example.com' }],
    ['top-level name', { ...status, name: 'Thandi' }],
    ['email inside data', { ...status, data: { ...statusData, email: 'a@example.com' } }],
    ['a fileName on an evidence event', { ...stored, data: { evidence: { evidenceId, fileName: 'receipt.pdf' } } }],
    ['a reason on EvidenceStored', { ...stored, data: { evidence: { evidenceId, reason: 'MALWARE' } } }],
    ['EvidenceRejected without a reason', { ...rejected, data: { evidence: { evidenceId } } }],
    ['an unknown rejection reason', { ...rejected, data: { evidence: { evidenceId, reason: 'VIRUS' } } }],
    ['status data on an evidence event', { ...stored, data: statusData }],
    ['evidence data on a status event', { ...status, data: { evidence: { evidenceId } } }],
    ['an unknown toStatus', { ...status, data: { ...statusData, toStatus: 'CLOSED' } }],
    ['an unknown reasonCode', { ...status, data: { ...statusData, reasonCode: 'CHANGED_MIND' } }],
    ['null', null],
    ['a JSON string', JSON.stringify(status)],
  ])('%s', (_name, input) => {
    const result = parseDisputeEvent(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('INVALID_EVENT');
  });

  it('reports paths and codes but never the offending values', () => {
    const result = parseDisputeEvent({ ...status, userId: 'thandi@example.com', email: 'thandi@example.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.join(' ')).not.toContain('thandi');
  });
});

describe('isStaleEvent', () => {
  it.each<[EventType, number, number, boolean]>([
    ['DisputeCreated', 1, 2, true],
    ['DisputeCreated', 1, 1, false],
    ['DisputeEdited', 2, 3, true],
    ['DisputeEdited', 3, 3, false],
    ['DisputeEdited', 4, 3, false],
    ['DisputeStatusChanged', 2, 3, true],
    ['DisputeStatusChanged', 3, 3, false],
    ['DisputeStatusChanged', 4, 3, false],
    ['EvidenceStored', 1, 5, false],
    ['EvidenceStored', 3, 3, false],
    ['EvidenceRejected', 1, 5, false],
    ['EvidenceRejected', 3, 3, false],
  ])('%s at version %i against current %i is stale: %s', (type, version, current, stale) => {
    expect(isStaleEvent(parsed({ ...valid[type], version }), current)).toBe(stale);
  });
});
