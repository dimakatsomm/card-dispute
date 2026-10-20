import {
  evaluateTransactionEligibility,
  validateDisputeInput,
  type EligibilityReason,
  type InputError,
} from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import {
  disputeCreatedEvent,
  toDisputeResource,
  toEligibilityTransaction,
  toTransactionRef,
} from '../core/dispute.ts';
import type {
  DisputeRecord,
  DisputeResource,
  EvidenceDeclaration,
  EvidenceRecord,
  UploadInstruction,
} from '../core/types.ts';
import type {
  FindCard,
  FindTransaction,
  PublishEvent,
  SigningError,
  SignUploads,
  Transact,
  UpstreamError,
} from './ports.ts';

export type CreateDisputeDeps = {
  readonly findTransaction: FindTransaction;
  readonly findCard: FindCard;
  readonly transact: Transact;
  readonly signUploads: SignUploads;
  readonly publish: PublishEvent;
  readonly newId: () => string;
};

export type CreateDisputeInput = {
  readonly userId: string;
  readonly transactionId: string;
  readonly reasonCode: string;
  readonly description: string;
  readonly evidence: ReadonlyArray<EvidenceDeclaration>;
  readonly correlationId: string;
};

export type CreatedDispute = DisputeResource & { readonly uploads: ReadonlyArray<UploadInstruction> };

export type CreateDisputeError = 'NOT_FOUND' | EligibilityReason | InputError | UpstreamError | SigningError;

type Inserted = { readonly dispute: DisputeRecord; readonly evidence: ReadonlyArray<EvidenceRecord> };

export const createDispute =
  (deps: CreateDisputeDeps) =>
  async (input: CreateDisputeInput): Promise<Result<CreatedDispute, CreateDisputeError>> => {
    const valid = validateDisputeInput(input);
    if (!valid.ok) return valid;

    const txn = await deps.findTransaction(input.userId, input.transactionId, input.correlationId);
    if (!txn.ok) return txn;
    if (txn.value === null) return err('NOT_FOUND');
    const card = await deps.findCard(input.userId, txn.value.cardId, input.correlationId);
    if (!card.ok) return card;
    if (card.value === null) return err('NOT_FOUND');
    const transaction = txn.value;
    const eligibilityCard = card.value;

    const inserted = await deps.transact<Inserted, CreateDisputeError>(async (tx) => {
      const existing = await tx.findByTransaction(input.transactionId, input.userId);
      const eligible = evaluateTransactionEligibility(
        toEligibilityTransaction(transaction),
        eligibilityCard,
        existing,
        await tx.now(),
      );
      if (!eligible.ok) return eligible;

      const dispute = await tx.insertDispute({
        transactionId: input.transactionId,
        userId: input.userId,
        reasonCode: valid.value.reasonCode,
        description: valid.value.description,
        createdBy: `USER:${input.userId}`,
      });
      if (!dispute.ok) return dispute;
      await tx.insertHistory({
        disputeRowId: dispute.value.id,
        action: 'CREATE',
        fromStatus: null,
        toStatus: dispute.value.status,
        actorType: 'USER',
        actorId: input.userId,
      });
      const evidence = await tx.insertEvidence(dispute.value.id, input.evidence);
      return ok({ dispute: dispute.value, evidence });
    });
    if (!inserted.ok) return inserted;

    const { dispute, evidence } = inserted.value;
    await deps.publish(disputeCreatedEvent(dispute, deps.newId()), input.correlationId);
    // The rows are committed either way; on failure the customer re-obtains URLs via re-sign (P-05).
    const uploads = await deps.signUploads(dispute.disputeId, evidence);
    if (!uploads.ok) return uploads;
    return ok({
      ...toDisputeResource(dispute, evidence, toTransactionRef(transaction)),
      uploads: uploads.value,
    });
  };
