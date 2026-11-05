import type { Result } from '@cd/shared/fp';

export const RETENTION_ROLE = 'disputes_retention';

export type ErasureCandidate = { readonly id: string; readonly disputeId: string };

export type EraseOutcome = 'erased' | 'already_erased';

export type EraseFailure = { readonly sqlState: string };

export type RetentionStore = {
  readonly currentUser: () => Promise<string>;
  readonly expirePendingEvidence: (cutoff: Date, limit: number) => Promise<number>;
  readonly findErasureCandidates: (cutoff: Date, limit: number) => Promise<ReadonlyArray<ErasureCandidate>>;
  readonly eraseDispute: (id: string) => Promise<Result<EraseOutcome, EraseFailure>>;
  readonly findErasedWithEvidence: (erasedSince: Date, limit: number) => Promise<ReadonlyArray<string>>;
};

export type DeleteFailure = { readonly errorName: string };

export type EvidenceObjects = {
  readonly deleteAllVersions: (prefix: string) => Promise<Result<number, DeleteFailure>>;
};

export type SweepLog = {
  readonly info: (obj: object, msg: string) => void;
  readonly error: (obj: object, msg: string) => void;
};

export type MetricName =
  | 'EvidenceExpired'
  | 'RetentionErased'
  | 'RetentionFailed'
  | 'EvidenceVersionsDeleted'
  | 'EvidenceDeleteFailed';
