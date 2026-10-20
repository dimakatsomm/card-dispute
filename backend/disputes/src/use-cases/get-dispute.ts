import { err, ok, type Result } from '@cd/shared/fp';
import { toDisputeResource, toTransactionRef } from '../core/dispute.ts';
import { buildTimeline } from '../core/timeline.ts';
import type { DisputeDetail, Transaction } from '../core/types.ts';
import type { DisputeKey, DisputeWithHistory, FindTransaction, UpstreamError } from './ports.ts';

export type GetDisputeDeps = {
  readonly findLatestWithHistory: (key: DisputeKey) => Promise<DisputeWithHistory | null>;
  readonly findTransaction: FindTransaction;
};

export type GetDisputeInput = {
  readonly userId: string;
  readonly transactionId: string;
  readonly correlationId: string;
};

export type GetDisputeError = 'NOT_FOUND';

const toDetail = (found: DisputeWithHistory, transaction: Transaction | null): DisputeDetail => {
  const resource = toDisputeResource(
    found.dispute,
    found.evidence,
    transaction === null ? null : toTransactionRef(transaction),
  );
  return {
    ...resource,
    evidence: resource.evidence.map((e, i) => {
      const reason = found.evidence[i]?.rejectionReason ?? null;
      return reason === null ? e : { ...e, rejectionReason: reason };
    }),
    timeline: buildTimeline(found.history, found.evidence),
  };
};

export const getDispute =
  (deps: GetDisputeDeps) =>
  async (input: GetDisputeInput): Promise<Result<DisputeDetail, GetDisputeError>> => {
    const found = await deps.findLatestWithHistory({
      transactionId: input.transactionId,
      userId: input.userId,
    });
    if (found === null) return err('NOT_FOUND');
    // Enrichment only: a failed or throwing lookup blanks transaction but never the dispute (docs/02).
    const txn: Result<Transaction | null, UpstreamError> = await deps
      .findTransaction(input.userId, input.transactionId, input.correlationId)
      .catch(() => err('UPSTREAM_UNAVAILABLE'));
    return ok(toDetail(found, txn.ok ? txn.value : null));
  };
