import { err, ok, type Result } from '@cd/shared/fp';
import { evidenceObjectKey, evidenceResultEvent } from '../core/dispute.ts';
import {
  decideOutcome,
  settlementOf,
  type EvidenceOutcome,
  type ReportedResult,
} from '../core/evidence-result.ts';
import type { DisputeRecord } from '../core/types.ts';
import type { PublishEvent, Transact } from './ports.ts';

export const EVIDENCE_INTAKE_ACTOR = 'evidence-intake';

export type RecordEvidenceResultDeps = {
  readonly transact: Transact;
  readonly publish: PublishEvent;
  readonly newId: () => string;
};

export type RecordEvidenceResultInput = {
  readonly transactionId: string;
  readonly evidenceId: string;
  readonly result: ReportedResult;
  readonly correlationId: string;
};

export type RecordEvidenceResultError = 'NOT_FOUND' | 'EVIDENCE_CLOSED' | 'RESULT_CONFLICT';

export type RecordedEvidence = {
  readonly evidenceId: string;
  readonly status: EvidenceOutcome['status'];
  readonly s3Key?: string;
};

type Recorded = {
  readonly dispute: DisputeRecord;
  readonly outcome: EvidenceOutcome;
  readonly settledAt: Date | null;
};

export const recordEvidenceResult =
  (deps: RecordEvidenceResultDeps) =>
  async (input: RecordEvidenceResultInput): Promise<Result<RecordedEvidence, RecordEvidenceResultError>> => {
    const recorded = await deps.transact<Recorded, RecordEvidenceResultError>(async (tx) => {
      const dispute = await tx.lockForShareByTransaction(input.transactionId);
      if (dispute === null) return err('NOT_FOUND');
      // The row lock orders concurrent results and the sweeper's expiry, so the status read here is the one we act on.
      const evidence = await tx.lockEvidence(dispute.id, input.evidenceId);
      if (evidence === null) return err('NOT_FOUND');

      const outcome = decideOutcome(evidence, input.result);
      const settlement = settlementOf(evidence.status, outcome);
      if (settlement === 'EVIDENCE_CLOSED' || settlement === 'RESULT_CONFLICT') return err(settlement);
      if (settlement === 'NO_OP') return ok({ dispute, outcome, settledAt: null });

      const settledAt = await tx.settleEvidence({
        disputeRowId: dispute.id,
        evidenceId: input.evidenceId,
        outcome,
        s3Key: outcome.status === 'STORED' ? evidenceObjectKey(dispute.disputeId, input.evidenceId) : null,
      });
      if (settledAt === null) throw new Error('locked PENDING evidence was not updated');
      await tx.insertHistory({
        disputeRowId: dispute.id,
        action: outcome.status === 'STORED' ? 'EVIDENCE_ADDED' : 'EVIDENCE_REJECTED',
        fromStatus: dispute.status,
        toStatus: dispute.status,
        actorType: 'SYSTEM_RULE',
        actorId: EVIDENCE_INTAKE_ACTOR,
        after: { evidenceId: input.evidenceId },
      });
      return ok({ dispute, outcome, settledAt });
    });
    if (!recorded.ok) return recorded;

    const { dispute, outcome, settledAt } = recorded.value;
    if (settledAt !== null) {
      await deps.publish(
        evidenceResultEvent(dispute, input.evidenceId, outcome, settledAt, deps.newId()),
        input.correlationId,
      );
    }
    return ok(
      outcome.status === 'STORED'
        ? {
            evidenceId: input.evidenceId,
            status: 'STORED',
            s3Key: evidenceObjectKey(dispute.disputeId, input.evidenceId),
          }
        : { evidenceId: input.evidenceId, status: 'REJECTED' },
    );
  };
