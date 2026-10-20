import type {
  DisputeCreated,
  DisputeEdited,
  DisputeStatus,
  DisputeStatusChanged,
  EligibilityTransaction,
  EvidenceRejected,
  EvidenceStored,
} from '@cd/dispute-domain';
import type { EvidenceOutcome } from './evidence-result.ts';
import type { DisputeRecord, DisputeResource, EvidenceRecord, Transaction, TransactionRef } from './types.ts';

export const toEligibilityTransaction = (txn: Transaction): EligibilityTransaction => ({
  type: txn.type,
  status: txn.status,
  postedAt: txn.postedAt === null ? null : new Date(txn.postedAt),
});

export const toTransactionRef = (txn: Transaction): TransactionRef => ({
  accountId: txn.accountId,
  cardId: txn.cardId,
  amount: txn.amount,
  currency: txn.currency,
  merchantName: txn.merchantName,
  transactionAt: txn.transactionAt,
  postedAt: txn.postedAt,
});

export const toDisputeResource = (
  dispute: DisputeRecord,
  evidence: ReadonlyArray<EvidenceRecord>,
  transaction: TransactionRef | null,
): DisputeResource => ({
  disputeId: dispute.disputeId,
  transactionId: dispute.transactionId,
  status: dispute.status,
  reasonCode: dispute.reasonCode,
  description: dispute.description,
  transaction,
  evidence: evidence.map((e) => ({
    evidenceId: e.evidenceId,
    fileName: e.fileName,
    contentType: e.contentType,
    sizeBytes: e.sizeBytes,
    status: e.status,
  })),
  version: dispute.version,
  createdAt: dispute.createdAt.toISOString(),
  updatedAt: dispute.updatedAt.toISOString(),
  resolvedAt: dispute.resolvedAt === null ? null : dispute.resolvedAt.toISOString(),
  resolutionNote: dispute.resolutionNote,
});

// Events carry ids only (docs/03): the notifier looks the recipient up by userId.
export const disputeCreatedEvent = (dispute: DisputeRecord, eventId: string): DisputeCreated => ({
  eventId,
  eventType: 'DisputeCreated',
  occurredAt: dispute.createdAt.toISOString(),
  disputeId: dispute.disputeId,
  transactionId: dispute.transactionId,
  userId: dispute.userId,
  version: dispute.version,
  data: { fromStatus: null, toStatus: dispute.status, reasonCode: dispute.reasonCode },
});

export type DisputeChange = {
  readonly from: DisputeStatus;
  readonly eventType: 'DisputeEdited' | 'DisputeStatusChanged';
};

export const disputeChangedEvent = (
  dispute: DisputeRecord,
  change: DisputeChange,
  eventId: string,
): DisputeEdited | DisputeStatusChanged => ({
  eventId,
  eventType: change.eventType,
  occurredAt: dispute.updatedAt.toISOString(),
  disputeId: dispute.disputeId,
  transactionId: dispute.transactionId,
  userId: dispute.userId,
  version: dispute.version,
  data: { fromStatus: change.from, toStatus: dispute.status, reasonCode: dispute.reasonCode },
});

// Keyed by ids only, so neither the customer nor the intake caller ever chooses an object path (ADR-055).
export const quarantineObjectKey = (transactionId: string, evidenceId: string): string =>
  `intake/${transactionId}/${evidenceId}`;

export const evidenceObjectKey = (disputeId: string, evidenceId: string): string =>
  `evidence/${disputeId}/${evidenceId}`;

// Same ids-only rule as the status events, and the version is unchanged because evidence never bumps it (ADR-055).
export const evidenceResultEvent = (
  dispute: DisputeRecord,
  evidenceId: string,
  outcome: EvidenceOutcome,
  occurredAt: Date,
  eventId: string,
): EvidenceStored | EvidenceRejected => {
  const envelope = {
    eventId,
    occurredAt: occurredAt.toISOString(),
    disputeId: dispute.disputeId,
    transactionId: dispute.transactionId,
    userId: dispute.userId,
    version: dispute.version,
  };
  return outcome.status === 'STORED'
    ? { ...envelope, eventType: 'EvidenceStored', data: { evidence: { evidenceId } } }
    : {
        ...envelope,
        eventType: 'EvidenceRejected',
        data: { evidence: { evidenceId, reason: outcome.reason } },
      };
};
