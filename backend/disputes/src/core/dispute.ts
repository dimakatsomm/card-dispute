import type { EligibilityTransaction } from '@cd/dispute-domain';
import type {
  DisputeEvent,
  DisputeRecord,
  DisputeResource,
  EvidenceRecord,
  Transaction,
  TransactionRef,
} from './types.ts';

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
export const disputeCreatedEvent = (dispute: DisputeRecord, eventId: string): DisputeEvent => ({
  eventId,
  eventType: 'DisputeCreated',
  occurredAt: dispute.createdAt.toISOString(),
  disputeId: dispute.disputeId,
  transactionId: dispute.transactionId,
  userId: dispute.userId,
  version: dispute.version,
  data: { fromStatus: null, toStatus: dispute.status, reasonCode: dispute.reasonCode },
});

export const evidenceObjectKey = (disputeId: string, evidenceId: string): string =>
  `evidence/${disputeId}/${evidenceId}`;
