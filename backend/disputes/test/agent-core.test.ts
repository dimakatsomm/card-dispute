import { describe, expect, it } from 'vitest';
import { isReplayVersion } from '../src/core/agent-decision.ts';
import { toAgentDetail, toQueuePage, type QueueRecord } from '../src/core/agent-view.ts';
import { decodeQueueCursor, encodeCursor, encodeQueueCursor } from '../src/core/cursor.ts';
import { sha256EvidenceDigest as evidenceDigest } from '../src/adapters/evidence-digest.ts';
import type { EvidenceDetail } from '../src/core/timeline.ts';
import type { DisputeRecord, HistoryRecord } from '../src/core/types.ts';

const AGENT_ID = '0192f0c1-0000-7000-8000-0000000000a1';
const USER_ID = '0192f0c1-0000-7000-8000-0000000000b2';
const E1 = '0192f0c1-0000-7000-8000-000000000001';
const E2 = '0192f0c1-0000-7000-8000-000000000002';

const evidence = (evidenceId: string, status: EvidenceDetail['status']): EvidenceDetail => ({
  evidenceId,
  fileName: `${evidenceId.slice(-1)}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
  status,
  rejectionReason: status === 'REJECTED' ? 'MALWARE' : null,
});

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 8, minute));

const history = (
  action: HistoryRecord['action'],
  toStatus: HistoryRecord['toStatus'],
  actorType: HistoryRecord['actorType'],
  actorId: string,
  minute: number,
  extra: Partial<HistoryRecord> = {},
): HistoryRecord => ({
  action,
  fromStatus: null,
  toStatus,
  actorType,
  actorId,
  actorLabel: null,
  note: null,
  before: null,
  after: null,
  createdAt: at(minute),
  ...extra,
});

const dispute: DisputeRecord = {
  id: '7',
  disputeId: '0192f0c1-0000-7000-8000-0000000000d1',
  transactionId: '0192f0c1-0000-7000-8000-0000000000e1',
  userId: USER_ID,
  reasonCode: 'FRAUD',
  description: 'I did not make this purchase at all.',
  status: 'UNDER_REVIEW',
  version: 2,
  resolvedAt: null,
  resolutionNote: null,
  createdAt: at(0),
  updatedAt: at(3),
};

describe('sha256EvidenceDigest', () => {
  it('ignores row order but changes when an item is declared or settled', () => {
    const base = evidenceDigest([evidence(E1, 'PENDING'), evidence(E2, 'STORED')]);
    expect(evidenceDigest([evidence(E2, 'STORED'), evidence(E1, 'PENDING')])).toBe(base);
    expect(evidenceDigest([evidence(E1, 'STORED'), evidence(E2, 'STORED')])).not.toBe(base);
    expect(evidenceDigest([evidence(E1, 'PENDING')])).not.toBe(base);
    expect(evidenceDigest([])).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('queue cursor', () => {
  it('round-trips and rejects tampered or customer-list cursors', () => {
    const position = { createdAt: '2026-10-01T08:00:00.123456Z', rowId: '42' };
    expect(decodeQueueCursor(encodeQueueCursor(position))).toEqual({ ok: true, value: position });
    const bad = [
      encodeCursor({ updatedAt: position.createdAt, disputeId: dispute.disputeId }),
      encodeQueueCursor({ ...position, rowId: '9223372036854775808' }),
      encodeQueueCursor({ ...position, rowId: '1; drop table dispute' }),
      encodeQueueCursor({ ...position, createdAt: '2026-02-30T08:00:00.000000Z' }),
      'not-base64-json',
    ];
    for (const cursor of bad)
      expect(decodeQueueCursor(cursor)).toEqual({ ok: false, error: 'INVALID_CURSOR' });
  });

  it('a page of limit + 1 rows yields a cursor at the last returned item', () => {
    const row = (n: number): QueueRecord => ({
      disputeId: dispute.disputeId,
      transactionId: dispute.transactionId,
      status: 'SUBMITTED',
      reasonCode: 'FRAUD',
      version: 1,
      createdAt: at(n),
      reviewerName: null,
      position: { createdAt: `2026-10-01T08:0${n}:00.000000Z`, rowId: String(n + 1) },
    });
    const page = toQueuePage([row(0), row(1), row(2)], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor === null ? null : decodeQueueCursor(page.nextCursor)).toEqual({
      ok: true,
      value: row(1).position,
    });
    expect(toQueuePage([row(0)], 2).nextCursor).toBeNull();
  });
});

describe('isReplayVersion', () => {
  it('accepts the version the change consumed or the current one, nothing older', () => {
    expect(isReplayVersion(3, 2)).toBe(true);
    expect(isReplayVersion(3, 3)).toBe(true);
    expect(isReplayVersion(3, 1)).toBe(false);
    expect(isReplayVersion(3, 4)).toBe(false);
  });
});

describe('toAgentDetail', () => {
  const rows = [
    history('CREATE', 'SUBMITTED', 'USER', USER_ID, 0),
    history('EVIDENCE_REJECTED', 'SUBMITTED', 'SYSTEM_RULE', 'evidence-intake', 1, {
      after: { evidenceId: E1 },
    }),
    history('REVIEW', 'UNDER_REVIEW', 'AGENT', AGENT_ID, 2, { actorLabel: 'Naledi M.' }),
    history('EVIDENCE_ADDED', 'UNDER_REVIEW', 'AGENT', 'legacy-bot', 3, { after: { evidenceId: E2 } }),
  ];

  it('attributes CUSTOMER / SYSTEM / AGENT, names only labelled AGENT rows, and never carries the owner id', () => {
    const detail = toAgentDetail({
      dispute,
      history: rows,
      evidence: [evidence(E1, 'REJECTED'), evidence(E2, 'STORED')],
      transaction: null,
      evidenceDigest: 'd'.repeat(64),
    });
    expect(detail.timeline).toEqual([
      { type: 'SUBMITTED', at: at(0).toISOString(), by: 'CUSTOMER' },
      {
        type: 'EVIDENCE_REJECTED',
        at: at(1).toISOString(),
        by: 'SYSTEM',
        detail: { fileName: '1.pdf', reason: 'MALWARE' },
      },
      { type: 'UNDER_REVIEW', at: at(2).toISOString(), by: 'AGENT', agentName: 'Naledi M.' },
      { type: 'EVIDENCE_ADDED', at: at(3).toISOString(), by: 'AGENT', detail: { fileName: '2.pdf' } },
    ]);
    expect(detail.pickedUpBy).toBe('Naledi M.');
    expect(detail.evidence[0]).toMatchObject({ evidenceId: E1, rejectionReason: 'MALWARE' });
    expect(detail.evidence[1]).not.toHaveProperty('rejectionReason');
    expect(JSON.stringify(detail)).not.toContain(USER_ID);
  });

  it('pickedUpBy is null when the REVIEW row carries no label', () => {
    expect(
      toAgentDetail({
        dispute,
        history: [history('REVIEW', 'UNDER_REVIEW', 'AGENT', AGENT_ID, 2)],
        evidence: [],
        transaction: null,
        evidenceDigest: 'd'.repeat(64),
      }).pickedUpBy,
    ).toBeNull();
  });
});
