import {
  applyAction,
  type DisputeAction,
  type DisputeStatus,
  type TransitionError,
} from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import {
  disputeChangedEvent,
  toDisputeResource,
  toTransactionRef,
  type DisputeChange,
} from '../core/dispute.ts';
import type { DisputeRecord, DisputeResource, EvidenceRecord, Transaction } from '../core/types.ts';
import type {
  DisputeChanges,
  FindTransaction,
  NewHistory,
  PublishEvent,
  Transact,
  UpstreamError,
} from './ports.ts';

export type UpdateDisputeDeps = {
  readonly transact: Transact;
  readonly findTransaction: FindTransaction;
  readonly publish: PublishEvent;
  readonly newId: () => string;
};

export type UpdateAction =
  | { readonly type: 'EDIT'; readonly reasonCode?: string; readonly description?: string }
  | { readonly type: 'WITHDRAW'; readonly note?: string };

export type UpdateDisputeInput = {
  readonly userId: string;
  readonly transactionId: string;
  readonly expectedVersion: number;
  readonly action: UpdateAction;
  readonly correlationId: string;
};

export type UpdateDisputeError = 'NOT_FOUND' | 'STALE_VERSION' | TransitionError;

type Editable = Pick<DisputeRecord, 'reasonCode' | 'description'>;

type Applied = {
  readonly dispute: DisputeRecord;
  readonly evidence: ReadonlyArray<EvidenceRecord>;
  readonly change: DisputeChange | null;
};

const toDomainAction = (action: UpdateAction): DisputeAction =>
  action.type === 'EDIT'
    ? {
        type: 'EDIT',
        changes: {
          ...(action.reasonCode === undefined ? {} : { reasonCode: action.reasonCode }),
          ...(action.description === undefined ? {} : { description: action.description }),
        },
      }
    : { type: 'WITHDRAW' };

const changedFields = (before: Editable, after: Editable): Partial<Editable> => ({
  ...(after.reasonCode === before.reasonCode ? {} : { reasonCode: after.reasonCode }),
  ...(after.description === before.description ? {} : { description: after.description }),
});

const priorValues = (before: Editable, changed: Partial<Editable>): Partial<Editable> => ({
  ...(changed.reasonCode === undefined ? {} : { reasonCode: before.reasonCode }),
  ...(changed.description === undefined ? {} : { description: before.description }),
});

const historyFor = (
  action: UpdateAction,
  current: DisputeRecord,
  to: DisputeStatus,
  changed: Partial<Editable>,
  userId: string,
): NewHistory => {
  const common = {
    disputeRowId: current.id,
    fromStatus: current.status,
    toStatus: to,
    actorType: 'USER',
    actorId: userId,
  } as const;
  return action.type === 'EDIT'
    ? { ...common, action: 'EDIT', before: priorValues(current, changed), after: changed }
    : { ...common, action: 'WITHDRAW', note: action.note ?? null };
};

export const updateDispute =
  (deps: UpdateDisputeDeps) =>
  async (input: UpdateDisputeInput): Promise<Result<DisputeResource, UpdateDisputeError>> => {
    const applied = await deps.transact<Applied, UpdateDisputeError>(async (tx) => {
      const current = await tx.lockForUpdate({ transactionId: input.transactionId, userId: input.userId });
      if (current === null) return err('NOT_FOUND');
      if (current.version !== input.expectedVersion) return err('STALE_VERSION');

      const transition = applyAction(current, toDomainAction(input.action), {
        type: 'USER',
        id: input.userId,
      });
      if (!transition.ok) return transition;
      if (transition.value.kind === 'NO_OP') {
        return ok({ dispute: current, evidence: await tx.listEvidence(current.id), change: null });
      }

      const { to } = transition.value;
      const changed = changedFields(current, transition.value.dispute);
      const changes: DisputeChanges = input.action.type === 'EDIT' ? changed : { status: to };
      const updated = await tx.updateWithVersion({
        disputeRowId: current.id,
        expectedVersion: current.version,
        changes,
        updatedBy: `USER:${input.userId}`,
      });
      if (!updated.ok) return updated;
      await tx.insertHistory(historyFor(input.action, current, to, changed, input.userId));
      return ok({
        dispute: updated.value,
        evidence: await tx.listEvidence(current.id),
        change: {
          from: current.status,
          eventType: input.action.type === 'EDIT' ? 'DisputeEdited' : 'DisputeStatusChanged',
        },
      });
    });
    if (!applied.ok) return applied;

    const { dispute, evidence, change } = applied.value;
    if (change !== null) {
      await deps.publish(disputeChangedEvent(dispute, change, deps.newId()), input.correlationId);
    }
    // The write is committed, so a failed or throwing lookup only blanks the enrichment (docs/02).
    const txn: Result<Transaction | null, UpstreamError> = await deps
      .findTransaction(input.userId, input.transactionId, input.correlationId)
      .catch(() => err('UPSTREAM_UNAVAILABLE'));
    const transaction = txn.ok && txn.value !== null ? toTransactionRef(txn.value) : null;
    return ok(toDisputeResource(dispute, evidence, transaction));
  };
