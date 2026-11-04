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

export type QueueStatus = QueueItem['status'];

export type QueueRecord = {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly status: QueueStatus;
  readonly reasonCode: ReasonCode;
  readonly version: number;
  readonly createdAt: Date;
  readonly reviewerName: string | null;
  readonly position: QueuePosition;
};

const BY_ACTOR: Readonly<Record<ActorType, AgentTimelineEvent['by']>> = {
  USER: 'CUSTOMER',
  AGENT: 'AGENT',
  SYSTEM_RULE: 'SYSTEM',
};

// The label is copied from the agent's token when the agent acts; AGENT rows without one show no name.
const agentNameOf = (entry: HistoryRecord): string | null =>
  entry.actorType === 'AGENT' ? entry.actorLabel : null;

const pickedUpByOf = (history: ReadonlyArray<HistoryRecord>): string | null => {
  const review = history.filter((h) => h.action === 'REVIEW' && h.actorType === 'AGENT').at(-1);
  return review === undefined ? null : agentNameOf(review);
};

export const buildAgentTimeline = (
  history: ReadonlyArray<HistoryRecord>,
  evidence: ReadonlyArray<EvidenceDetail>,
): ReadonlyArray<AgentTimelineEvent> =>
  timelineEntries(history, evidence).map(({ type, entry, detail }) => {
    const agentName = agentNameOf(entry);
    return {
      type,
      at: entry.createdAt.toISOString(),
      by: BY_ACTOR[entry.actorType],
      ...(agentName === null ? {} : { agentName }),
      ...(detail === undefined ? {} : { detail }),
    };
  });

export type AgentDetailParts = {
  readonly dispute: DisputeRecord;
  readonly history: ReadonlyArray<HistoryRecord>;
  readonly evidence: ReadonlyArray<EvidenceDetail>;
  readonly transaction: TransactionRef | null;
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
    evidence: parts.evidence.map((e) => ({
      evidenceId: e.evidenceId,
      fileName: e.fileName,
      contentType: e.contentType,
      sizeBytes: e.sizeBytes,
      status: e.status,
      ...(e.rejectionReason === null ? {} : { rejectionReason: e.rejectionReason }),
    })),
    evidenceDigest: parts.evidenceDigest,
    version: resource.version,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    resolvedAt: resource.resolvedAt,
    resolutionNote: resource.resolutionNote,
    pickedUpBy: pickedUpByOf(parts.history),
    timeline: buildAgentTimeline(parts.history, parts.evidence),
  };
};

const toQueueItem = (row: QueueRecord): QueueItem => ({
  disputeId: row.disputeId,
  transactionId: row.transactionId,
  status: row.status,
  reasonCode: row.reasonCode,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  pickedUpBy: row.reviewerName,
});

// The repository is asked for limit + 1 rows; the extra row only signals that another page exists.
export const toQueuePage = (rows: ReadonlyArray<QueueRecord>, limit: number): ReviewQueuePage => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toQueueItem),
    nextCursor: rows.length > limit && last !== undefined ? encodeQueueCursor(last.position) : null,
  };
};
