import type {
  zDispute,
  zDisputeCreated,
  zDisputeDetail,
  zDisputeSummary,
  zEvidence,
  zEvidenceDeclaration,
  zListMyDisputesResponse,
  zTimelineEvent,
  zTransactionSnapshot,
  zUploadInstruction,
} from '@cd/contracts/disputes.public';
import type {
  CardStatus,
  DisputeStatus,
  ReasonCode,
  TransactionStatus,
  TransactionType,
} from '@cd/dispute-domain';
import type { z } from 'zod';

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

type Wire<S extends z.ZodType> = DeepReadonly<z.output<S>>;

export type Transaction = {
  readonly transactionId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly amount: string;
  readonly currency: string;
  readonly merchantName: string;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  readonly transactionAt: string;
  readonly postedAt: string | null;
};

export type Card = {
  readonly cardId: string;
  readonly userId: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly status: CardStatus;
};

export type EvidenceDeclaration = Wire<typeof zEvidenceDeclaration>;

export type EvidenceStatus = Wire<typeof zEvidence>['status'];

export type EvidenceRecord = EvidenceDeclaration & {
  readonly evidenceId: string;
  readonly status: EvidenceStatus;
};

export type DisputeRecord = {
  readonly id: string;
  readonly disputeId: string;
  readonly transactionId: string;
  readonly userId: string;
  readonly reasonCode: ReasonCode;
  readonly description: string;
  readonly status: DisputeStatus;
  readonly version: number;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type HistoryAction =
  'CREATE' | 'EDIT' | 'EVIDENCE_ADDED' | 'EVIDENCE_REJECTED' | 'REVIEW' | 'RESOLVE' | 'WITHDRAW';

export type HistoryRecord = {
  readonly action: HistoryAction;
  readonly fromStatus: DisputeStatus | null;
  readonly toStatus: DisputeStatus;
  readonly actorType: 'USER' | 'SYSTEM_RULE' | 'AGENT';
  readonly actorId: string;
  readonly note: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: Date;
};

export type UploadInstruction = Wire<typeof zUploadInstruction>;

export type DisputeEvent = {
  readonly eventId: string;
  readonly eventType: 'DisputeCreated' | 'DisputeEdited' | 'DisputeStatusChanged' | 'EvidenceUploaded';
  readonly occurredAt: string;
  readonly disputeId: string;
  readonly transactionId: string;
  readonly userId: string;
  readonly version: number;
  readonly data: {
    readonly fromStatus: DisputeStatus | null;
    readonly toStatus: DisputeStatus;
    readonly reasonCode: ReasonCode;
  };
};

export type TransactionRef = Wire<typeof zTransactionSnapshot>;

export type DisputeResource = Wire<typeof zDispute>;

export type CreatedDispute = Wire<typeof zDisputeCreated>;

export type DisputeDetail = Wire<typeof zDisputeDetail>;

export type DisputeSummary = Wire<typeof zDisputeSummary>;

export type DisputePage = Wire<typeof zListMyDisputesResponse>;

export type TimelineEvent = Wire<typeof zTimelineEvent>;
