import type { ActorType, ReasonCode } from '@cd/dispute-domain';
import { encodeQueueCursor, type QueuePosition } from './cursor.ts';
import { toDisputeResource } from './dispute.ts';
import { timelineEntries, type EvidenceDetail } from './timeline.ts';
import type {
  AgentDisputeDetail,
  AgentTimelineEvent,
  DisputeRecord,
  HistoryRecord,
  QueueItem,
  ReviewQueuePage,
  TransactionRef,
} from './types.ts';

export type AgentNames = ReadonlyMap<string, string>;

export type QueueStatus = QueueItem['status'];

export type QueueRecord = {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly status: QueueStatus;
  readonly reasonCode: ReasonCode;
  readonly version: number;
  readonly createdAt: Date;
  readonly reviewerId: string | null;
  readonly position: QueuePosition;
};

const BY_ACTOR: Readonly<Record<ActorType, AgentTimelineEvent['by']>> = {
  USER: 'CUSTOMER',
  AGENT: 'AGENT',
  SYSTEM_RULE: 'SYSTEM',
};

export const agentActorIds = (history: ReadonlyArray<HistoryRecord>): ReadonlyArray<string> => [
  ...new Set(history.filter((h) => h.actorType === 'AGENT').map((h) => h.actorId)),
];

const reviewerOf = (history: ReadonlyArray<HistoryRecord>): string | null =>
  history.filter((h) => h.action === 'REVIEW' && h.actorType === 'AGENT').at(-1)?.actorId ?? null;

const nameOf = (names: AgentNames, agentId: string | null): string | null =>
  agentId === null ? null : (names.get(agentId) ?? null);

export const buildAgentTimeline = (
  history: ReadonlyArray<HistoryRecord>,
  evidence: ReadonlyArray<EvidenceDetail>,
  names: AgentNames,
): ReadonlyArray<AgentTimelineEvent> =>
  timelineEntries(history, evidence).map(({ type, entry, detail }) => {
    const by = BY_ACTOR[entry.actorType];
    const agentName = by === 'AGENT' ? names.get(entry.actorId) : undefined;
    return {
      type,
      at: entry.createdAt.toISOString(),
      by,
      ...(agentName === undefined ? {} : { agentName }),
      ...(detail === undefined ? {} : { detail }),
    };
  });

export type AgentDetailParts = {
  readonly dispute: DisputeRecord;
  readonly history: ReadonlyArray<HistoryRecord>;
  readonly evidence: ReadonlyArray<EvidenceDetail>;
  readonly transaction: TransactionRef | null;
  readonly names: AgentNames;
  readonly evidenceDigest: string;
};

// Built field by field rather than spread, so nothing customer-identifying (userId) can ride along.
export const toAgentDetail = (parts: AgentDetailParts): AgentDisputeDetail => {
  const resource = toDisputeResource(parts.dispute, parts.evidence, parts.transaction);
  return {
    disputeId: resource.disputeId,
    transactionId: resource.transactionId,
    status: resource.status,
    reasonCode: resource.reasonCode,
    description: resource.description,
    transaction: resource.transaction,
    evidence: resource.evidence.map((e, i) => {
      const reason = parts.evidence[i]?.rejectionReason ?? null;
      return reason === null ? e : { ...e, rejectionReason: reason };
    }),
    evidenceDigest: parts.evidenceDigest,
    version: resource.version,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    resolvedAt: resource.resolvedAt,
    resolutionNote: resource.resolutionNote,
    pickedUpBy: nameOf(parts.names, reviewerOf(parts.history)),
    timeline: buildAgentTimeline(parts.history, parts.evidence, parts.names),
  };
};

const toQueueItem = (row: QueueRecord, names: AgentNames): QueueItem => ({
  disputeId: row.disputeId,
  transactionId: row.transactionId,
  status: row.status,
  reasonCode: row.reasonCode,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  pickedUpBy: nameOf(names, row.reviewerId),
});

// The repository is asked for limit + 1 rows; the extra row only signals that another page exists.
export const toQueuePage = (
  rows: ReadonlyArray<QueueRecord>,
  limit: number,
  names: AgentNames,
): ReviewQueuePage => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map((row) => toQueueItem(row, names)),
    nextCursor: rows.length > limit && last !== undefined ? encodeQueueCursor(last.position) : null,
  };
};

export const queueReviewerIds = (rows: ReadonlyArray<QueueRecord>): ReadonlyArray<string> => [
  ...new Set(rows.flatMap((r) => (r.reviewerId === null ? [] : [r.reviewerId]))),
];
