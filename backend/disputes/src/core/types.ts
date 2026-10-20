import type {
  CardStatus,
  DisputeStatus,
  ReasonCode,
  TransactionStatus,
  TransactionType,
} from '@cd/dispute-domain';

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

export const EVIDENCE_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

export type EvidenceDeclaration = {
  readonly fileName: string;
  readonly contentType: EvidenceContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
};

export type EvidenceStatus = 'PENDING' | 'STORED' | 'REJECTED' | 'EXPIRED' | 'ERASED';

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

export type UploadInstruction = {
  readonly evidenceId: string;
  readonly method: 'PUT';
  readonly url: string;
  readonly headers: {
    readonly 'Content-Type': string;
    readonly 'Content-Length': string;
    readonly 'x-amz-checksum-sha256': string;
  };
  readonly expiresAt: string;
};

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

export type TransactionRef = {
  readonly accountId: string;
  readonly cardId: string;
  readonly amount: string;
  readonly currency: string;
  readonly merchantName: string;
  readonly transactionAt: string;
  readonly postedAt: string | null;
};

export type DisputeResource = {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly status: DisputeStatus;
  readonly reasonCode: ReasonCode;
  readonly description: string;
  readonly transaction: TransactionRef | null;
  readonly evidence: ReadonlyArray<{
    readonly evidenceId: string;
    readonly fileName: string;
    readonly contentType: EvidenceContentType;
    readonly sizeBytes: number;
    readonly status: EvidenceStatus;
  }>;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
};
