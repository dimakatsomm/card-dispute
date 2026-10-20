import { erasureCutoff, slotExpiryCutoff } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { RETENTION_ROLE, type MetricName, type RetentionStore, type SweepLog } from './ports.ts';

export type SweepSummary = { readonly expired: number; readonly erased: number };

export type SweepError =
  | { readonly kind: 'invalid_clock' }
  | { readonly kind: 'wrong_role'; readonly actual: string }
  | { readonly kind: 'erase_failed'; readonly summary: SweepSummary; readonly failedDisputeIds: ReadonlyArray<string> };

export type SweepDeps = {
  readonly store: RetentionStore;
  readonly batchSize: number;
  readonly log: SweepLog;
  readonly metric: (name: MetricName, value: number) => void;
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

    const summary = { expired, erased: erasedIds.length };
    return failedIds.length === 0 ? ok(summary) : err({ kind: 'erase_failed', summary, failedDisputeIds: failedIds });
  };
