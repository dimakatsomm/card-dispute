import type { ActorType, DisputeStatus, ReasonCode } from '@cd/dispute-domain';
import type { Result } from '@cd/shared/fp';
import type {
  Card,
  DisputeEvent,
  DisputeRecord,
  EvidenceDeclaration,
  EvidenceRecord,
  HistoryAction,
  HistoryRecord,
  Transaction,
  UploadInstruction,
} from '../core/types.ts';
import type { CursorPosition } from '../core/cursor.ts';
import type { EvidenceDetail, LatestHistory } from '../core/timeline.ts';

export type UpstreamError = 'UPSTREAM_UNAVAILABLE';

export type Lookup<T> = Promise<Result<T | null, UpstreamError>>;

export type FindTransaction = (
  userId: string,
  transactionId: string,
  correlationId: string,
) => Lookup<Transaction>;

export type TransactionFilter = { readonly accountId?: string; readonly cardId?: string };

export type FindTransactions = (
  userId: string,
  transactionIds: ReadonlyArray<string>,
  filter: TransactionFilter,
  correlationId: string,
) => Promise<Result<ReadonlyArray<Transaction>, UpstreamError>>;

export type FindCard = (userId: string, cardId: string, correlationId: string) => Lookup<Card>;

export type DisputeKey =
  | { readonly transactionId: string; readonly userId: string }
  | { readonly disputeId: string; readonly userId: string };

export type NewDispute = {
  readonly transactionId: string;
  readonly userId: string;
  readonly reasonCode: ReasonCode;
  readonly description: string;
  readonly createdBy: string;
};

export type NewHistory = {
  readonly disputeRowId: string;
  readonly action: HistoryAction;
  readonly fromStatus: DisputeStatus | null;
  readonly toStatus: DisputeStatus;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly note?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
};

export type DisputeChanges = {
  readonly status?: DisputeStatus;
  readonly reasonCode?: ReasonCode;
  readonly description?: string;
  readonly resolvedAt?: Date | null;
  readonly resolutionNote?: string | null;
};

export type VersionedUpdate = {
  readonly disputeRowId: string;
  readonly expectedVersion: number;
  readonly changes: DisputeChanges;
  readonly updatedBy: string;
};

export type DisputeTx = {
  readonly now: () => Promise<Date>;
  readonly findByTransaction: (transactionId: string, userId: string) => Promise<DisputeRecord | null>;
  readonly lockForUpdate: (key: DisputeKey) => Promise<DisputeRecord | null>;
  readonly insertDispute: (dispute: NewDispute) => Promise<Result<DisputeRecord, 'ALREADY_DISPUTED'>>;
  readonly insertHistory: (entry: NewHistory) => Promise<void>;
  readonly insertEvidence: (
    disputeRowId: string,
    evidence: ReadonlyArray<EvidenceDeclaration>,
  ) => Promise<ReadonlyArray<EvidenceRecord>>;
  readonly listEvidence: (disputeRowId: string) => Promise<ReadonlyArray<EvidenceRecord>>;
  readonly updateWithVersion: (update: VersionedUpdate) => Promise<Result<DisputeRecord, 'STALE_VERSION'>>;
};

export type Transact = <T, E>(work: (tx: DisputeTx) => Promise<Result<T, E>>) => Promise<Result<T, E>>;

export type DisputeWithHistory = {
  readonly dispute: DisputeRecord;
  readonly history: ReadonlyArray<HistoryRecord>;
  readonly evidence: ReadonlyArray<EvidenceDetail>;
};

export type DisputePageQuery = {
  readonly userId: string;
  readonly statuses: ReadonlyArray<DisputeStatus>;
  readonly transactionIds: ReadonlyArray<string> | null;
  readonly after: CursorPosition | null;
  readonly limit: number;
};

export type DisputeSummaryRecord = {
  readonly dispute: DisputeRecord;
  readonly latest: LatestHistory | null;
  readonly position: CursorPosition;
};

export type DisputeRef = {
  readonly transactionId: string;
  readonly disputeId: string;
  readonly status: DisputeStatus;
  readonly version: number;
};

export type ListDisputeTransactionIds = (
  userId: string,
  statuses: ReadonlyArray<DisputeStatus>,
) => Promise<ReadonlyArray<string>>;

export type ListDisputePage = (query: DisputePageQuery) => Promise<ReadonlyArray<DisputeSummaryRecord>>;

export type LookupDisputeRefs = (
  userId: string,
  transactionIds: ReadonlyArray<string>,
) => Promise<ReadonlyArray<DisputeRef>>;

export type DisputeRepo = {
  readonly transact: Transact;
  readonly findLatestWithHistory: (key: DisputeKey) => Promise<DisputeWithHistory | null>;
  readonly listTransactionIds: ListDisputeTransactionIds;
  readonly listPage: ListDisputePage;
  readonly lookupRefs: LookupDisputeRefs;
};

export type SigningError = 'UPLOAD_SIGNING_UNAVAILABLE';

export type UploadTarget = { readonly disputeId: string; readonly transactionId: string };

export type SignUploads = (
  target: UploadTarget,
  evidence: ReadonlyArray<EvidenceRecord>,
) => Promise<Result<ReadonlyArray<UploadInstruction>, SigningError>>;

export type PublishEvent = (event: DisputeEvent, correlationId: string) => Promise<void>;
