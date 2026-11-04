import { applyAction } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { isReplayVersion, toDomainAction, type AgentDecision } from '../core/agent-decision.ts';
import { disputeChangedEvent, type DisputeChange } from '../core/dispute.ts';
import type { AgentDisputeDetail, DisputeRecord } from '../core/types.ts';
import type { GetAgentDisputeInput } from './agent-dispute.ts';
import type { DisputeChanges, EvidenceDigest, NewHistory, PublishEvent, Transact } from './ports.ts';

export type DecideDisputeDeps = {
  readonly transact: Transact;
  readonly publish: PublishEvent;
  readonly newId: () => string;
  readonly evidenceDigest: EvidenceDigest;
  readonly getAgentDispute: (input: GetAgentDisputeInput) => Promise<Result<AgentDisputeDetail, 'NOT_FOUND'>>;
};

export type DecideDisputeInput = {
  readonly agentId: string;
  readonly agentName: string;
  readonly transactionId: string;
  readonly decision: AgentDecision;
  readonly expectedVersion: number;
  readonly expectedEvidenceDigest: string;
  readonly correlationId: string;
};

export type DecideDisputeError = 'NOT_FOUND' | 'STALE_VERSION' | 'STALE_EVIDENCE' | 'INVALID_TRANSITION';

type Applied = { readonly dispute: DisputeRecord; readonly change: DisputeChange } | null;

const changesFor = (decision: AgentDecision, to: DisputeRecord['status'], now: Date): DisputeChanges =>
  decision.type === 'REVIEW'
    ? { status: to }
    : { status: to, resolvedAt: now, resolutionNote: decision.note };

const historyFor = (
  decision: AgentDecision,
  current: DisputeRecord,
  to: DisputeRecord['status'],
  input: Pick<DecideDisputeInput, 'agentId' | 'agentName'>,
): NewHistory => ({
  disputeRowId: current.id,
  action: decision.type,
  fromStatus: current.status,
  toStatus: to,
  actorType: 'AGENT',
  actorId: input.agentId,
  actorLabel: input.agentName,
  note: decision.type === 'RESOLVE' ? decision.note : null,
});

export const decideDispute =
  (deps: DecideDisputeDeps) =>
  async (input: DecideDisputeInput): Promise<Result<AgentDisputeDetail, DecideDisputeError>> => {
    const applied = await deps.transact<Applied, DecideDisputeError>(async (tx) => {
      const current = await tx.lockForAgent(input.transactionId);
      if (current === null) return err('NOT_FOUND');

      // A terminal state answers 409 before staleness, so the loser of a race learns the outcome (docs/04).
      const transition = applyAction(current, toDomainAction(input.decision), {
        type: 'AGENT',
        id: input.agentId,
      });
      if (!transition.ok) return err('INVALID_TRANSITION');
      if (transition.value.kind === 'NO_OP') {
        return isReplayVersion(current.version, input.expectedVersion) ? ok(null) : err('STALE_VERSION');
      }

      if (current.version !== input.expectedVersion) return err('STALE_VERSION');
      // The dispute row lock serialises evidence declarations and results against this check.
      if (deps.evidenceDigest(await tx.listEvidence(current.id)) !== input.expectedEvidenceDigest) {
        return err('STALE_EVIDENCE');
      }

      const { to } = transition.value;
      const updated = await tx.updateWithVersion({
        disputeRowId: current.id,
        expectedVersion: current.version,
        changes: changesFor(input.decision, to, await tx.now()),
        updatedBy: `AGENT:${input.agentId}`,
      });
      if (!updated.ok) return updated;
      await tx.insertHistory(historyFor(input.decision, current, to, input));
      return ok({
        dispute: updated.value,
        change: { from: current.status, eventType: 'DisputeStatusChanged' },
      });
    });
    if (!applied.ok) return applied;

    if (applied.value !== null) {
      const { dispute, change } = applied.value;
      await deps.publish(disputeChangedEvent(dispute, change, deps.newId()), input.correlationId);
    }
    return deps.getAgentDispute({ transactionId: input.transactionId, correlationId: input.correlationId });
  };
