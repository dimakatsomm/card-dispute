import { erasureCutoff, evidenceObjectKey, slotExpiryCutoff } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import {
  RETENTION_ROLE,
  type EvidenceObjects,
  type MetricName,
  type RetentionStore,
  type SweepLog,
} from './ports.ts';

const DAY_MS = 86_400_000;

export type SweepSummary = {
  readonly expired: number;
  readonly erased: number;
  readonly evidenceVersionsDeleted: number;
};

export type SweepError =
  | { readonly kind: 'invalid_clock' }
  | { readonly kind: 'wrong_role'; readonly actual: string }
  | {
      readonly kind: 'incomplete';
      readonly summary: SweepSummary;
      readonly eraseFailedIds: ReadonlyArray<string>;
      readonly deleteFailedIds: ReadonlyArray<string>;
    };

export type EvidencePurge = { readonly objects: EvidenceObjects; readonly retryDays: number };

export type SweepDeps = {
  readonly store: RetentionStore;
  readonly batchSize: number;
  readonly log: SweepLog;
  readonly metric: (name: MetricName, value: number) => void;
  readonly evidence?: EvidencePurge;
};

// The trailing slash from the shared key convention keeps one dispute's folder from matching another id's.
export const evidencePrefix = (disputeId: string): string => evidenceObjectKey(disputeId, '');

type PurgeOutcome = { readonly deleted: number; readonly failedIds: ReadonlyArray<string> };

// The DB keeps no "bytes deleted" marker, so every erasure inside the retry window is re-listed each run.
const purgeErasedEvidence = async (deps: SweepDeps, purge: EvidencePurge, now: Date): Promise<PurgeOutcome> => {
  const since = new Date(now.getTime() - purge.retryDays * DAY_MS);
  const disputeIds = await deps.store.findErasedWithEvidence(since, deps.batchSize);
  let deleted = 0;
  const failedIds: string[] = [];
  for (const disputeId of disputeIds) {
    const outcome = await purge.objects.deleteAllVersions(evidencePrefix(disputeId));
    if (!outcome.ok) {
      failedIds.push(disputeId);
      deps.log.error({ disputeId, errorName: outcome.error.errorName }, 'evidence object deletion failed');
    } else if (outcome.value > 0) {
      deleted += outcome.value;
      deps.log.info({ disputeId, versionsDeleted: outcome.value }, 'evidence objects deleted');
    }
  }
  deps.metric('EvidenceVersionsDeleted', deleted);
  if (failedIds.length > 0) deps.metric('EvidenceDeleteFailed', failedIds.length);
  return { deleted, failedIds };
};

export const sweepRetention =
  (deps: SweepDeps) =>
  async (now: Date): Promise<Result<SweepSummary, SweepError>> => {
    // An invalid clock would make every cutoff comparison meaningless, so stop before touching the DB.
    if (Number.isNaN(now.getTime())) return err({ kind: 'invalid_clock' });
    const actual = await deps.store.currentUser();
    if (actual !== RETENTION_ROLE) return err({ kind: 'wrong_role', actual });

    const expired = await deps.store.expirePendingEvidence(slotExpiryCutoff(now), deps.batchSize);
    deps.metric('EvidenceExpired', expired);

    const candidates = await deps.store.findErasureCandidates(erasureCutoff(now), deps.batchSize);
    const erasedIds: string[] = [];
    const failedIds: string[] = [];
    // Sequential so each dispute is its own short transaction and one failure cannot hide the others.
    for (const candidate of candidates) {
      const outcome = await deps.store.eraseDispute(candidate.id);
      if (!outcome.ok) {
        failedIds.push(candidate.disputeId);
        deps.log.error({ disputeId: candidate.disputeId, sqlState: outcome.error.sqlState }, 'dispute erasure failed');
      } else if (outcome.value === 'erased') {
        erasedIds.push(candidate.disputeId);
        deps.log.info({ disputeId: candidate.disputeId }, 'dispute erased');
      }
    }
    deps.metric('RetentionErased', erasedIds.length);
    if (failedIds.length > 0) deps.metric('RetentionFailed', failedIds.length);

    // Runs only after every erase above has committed, and reads its targets back from committed rows (rule 6).
    const purge = deps.evidence ? await purgeErasedEvidence(deps, deps.evidence, now) : { deleted: 0, failedIds: [] };

    const summary = { expired, erased: erasedIds.length, evidenceVersionsDeleted: purge.deleted };
    return failedIds.length === 0 && purge.failedIds.length === 0
      ? ok(summary)
      : err({ kind: 'incomplete', summary, eraseFailedIds: failedIds, deleteFailedIds: purge.failedIds });
  };
