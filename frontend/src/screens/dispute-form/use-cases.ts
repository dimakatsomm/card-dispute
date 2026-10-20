import { ok, type Result } from '../../app/result';
import {
  matchUploads,
  prepareFiles,
  toDeclaration,
  type EvidenceDeps,
  type MatchedUpload,
  type SelectedFile,
} from '../../components/evidence';
import type { ReasonCode } from '../../lib/dispute-reasons';
import type { DisputeApi } from './api';
import type { CreateFailure } from './core';

export type DisputeFormDeps = DisputeApi & EvidenceDeps;

export type SubmitDisputeInput = {
  readonly transactionId: string;
  readonly reasonCode: ReasonCode;
  readonly description: string;
  readonly files: ReadonlyArray<SelectedFile>;
};

export const submitDispute =
  (deps: Pick<DisputeFormDeps, 'createDispute' | 'sha256Hex'>) =>
  async (input: SubmitDisputeInput): Promise<Result<ReadonlyArray<MatchedUpload>, CreateFailure>> => {
    const prepared = await prepareFiles(deps)(input.files);
    const created = await deps.createDispute(input.transactionId, {
      reasonCode: input.reasonCode,
      description: input.description,
      ...(prepared.length > 0 ? { evidence: prepared.map(toDeclaration) } : {}),
    });
    return created.ok ? ok(matchUploads(prepared, created.value)) : created;
  };
