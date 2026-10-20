import { isTerminal } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { exceedsEvidenceCap, newDeclarations, planEvidenceSlots, slotRecords } from '../core/evidence.ts';
import type { DisputeRecord, EvidenceDeclaration, EvidenceRecord, UploadInstruction } from '../core/types.ts';
import type { SigningError, SignUploads, Transact } from './ports.ts';

export type AddEvidenceDeps = {
  readonly transact: Transact;
  readonly signUploads: SignUploads;
};

export type AddEvidenceInput = {
  readonly userId: string;
  readonly transactionId: string;
  readonly evidence: ReadonlyArray<EvidenceDeclaration>;
};

export type AddEvidenceError = 'NOT_FOUND' | 'INVALID_TRANSITION' | 'TOO_MANY_FILES' | SigningError;

export type AddedEvidence = { readonly uploads: ReadonlyArray<UploadInstruction> };

type Slotted = { readonly dispute: DisputeRecord; readonly evidence: ReadonlyArray<EvidenceRecord> };

export const addEvidence =
  (deps: AddEvidenceDeps) =>
  async (input: AddEvidenceInput): Promise<Result<AddedEvidence, AddEvidenceError>> => {
    // The row lock serialises concurrent declarations, so the cap is checked against committed slots only.
    const slotted = await deps.transact<Slotted, AddEvidenceError>(async (tx) => {
      const dispute = await tx.lockForUpdate({ transactionId: input.transactionId, userId: input.userId });
      if (dispute === null) return err('NOT_FOUND');
      if (isTerminal(dispute.status)) return err('INVALID_TRANSITION');

      const existing = await tx.listEvidence(dispute.id);
      const slots = planEvidenceSlots(existing, input.evidence);
      if (exceedsEvidenceCap(existing, slots)) return err('TOO_MANY_FILES');
      const inserted = await tx.insertEvidence(dispute.id, newDeclarations(slots));
      return ok({ dispute, evidence: slotRecords(slots, inserted) });
    });
    if (!slotted.ok) return slotted;

    // Slots stay committed on failure; repeating the request re-signs them instead of adding more.
    const uploads = await deps.signUploads(slotted.value.dispute, slotted.value.evidence);
    if (!uploads.ok) return uploads;
    return ok({ uploads: uploads.value });
  };
