import { err, ok, type Result } from '../../app/result';
import type { UploadError } from '../../lib/upload';
import type { EvidenceApi } from './api';
import {
  matchUploads,
  toDeclaration,
  type EvidenceFailure,
  type MatchedUpload,
  type PreparedFile,
  type SelectedFile,
  type UploadInstruction,
} from './core';

export type EvidenceDeps = EvidenceApi & {
  readonly sha256Hex: (file: Blob) => Promise<string>;
  readonly uploadEvidence: (
    instruction: UploadInstruction,
    file: Blob,
    onProgress: (fraction: number) => void,
  ) => Promise<Result<void, UploadError>>;
};

export const prepareFiles =
  (deps: Pick<EvidenceDeps, 'sha256Hex'>) =>
  (files: ReadonlyArray<SelectedFile>): Promise<ReadonlyArray<PreparedFile>> =>
    Promise.all(files.map(async (file): Promise<PreparedFile> => ({ ...file, sha256Hex: await deps.sha256Hex(file.file) })));

export const declareEvidence =
  (deps: Pick<EvidenceDeps, 'addEvidence' | 'sha256Hex'>) =>
  async (input: {
    readonly transactionId: string;
    readonly files: ReadonlyArray<SelectedFile>;
  }): Promise<Result<ReadonlyArray<MatchedUpload>, EvidenceFailure>> => {
    const prepared = await prepareFiles(deps)(input.files);
    const added = await deps.addEvidence(input.transactionId, prepared.map(toDeclaration));
    return added.ok ? ok(matchUploads(prepared, added.value)) : added;
  };

// Re-declaring the same file re-signs its PENDING slot (ADR-050), so a retry never consumes another of the 5.
export const requestFreshUpload =
  (deps: Pick<EvidenceDeps, 'addEvidence'>) =>
  async (input: {
    readonly transactionId: string;
    readonly file: PreparedFile;
  }): Promise<Result<UploadInstruction, EvidenceFailure | 'NO_MATCHING_UPLOAD'>> => {
    const added = await deps.addEvidence(input.transactionId, [toDeclaration(input.file)]);
    if (!added.ok) return added;
    const [match] = matchUploads([input.file], added.value);
    return match?.[1] ? ok(match[1]) : err('NO_MATCHING_UPLOAD');
  };
