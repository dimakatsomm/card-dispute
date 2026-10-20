import { useCallback, useMemo, useState } from 'react';
import { uploadFailureMessage, type MatchedUpload, type PreparedFile, type UploadInstruction } from './core';
import { requestFreshUpload, type EvidenceDeps } from './use-cases';

export type UploadState =
  | { readonly kind: 'uploading'; readonly progress: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly message: string };

export type FileUpload = { readonly prepared: PreparedFile; readonly state: UploadState };

export const useEvidenceUploads = (transactionId: string, deps: EvidenceDeps) => {
  const [uploads, setUploads] = useState<ReadonlyArray<FileUpload> | null>(null);
  const freshUpload = useMemo(() => requestFreshUpload(deps), [deps]);

  const setUploadState = useCallback((key: string, state: UploadState) => {
    setUploads((current) => current && current.map((f) => (f.prepared.key === key ? { ...f, state } : f)));
  }, []);

  const runUpload = useCallback(
    async (prepared: PreparedFile, instruction: UploadInstruction) => {
      const result = await deps.uploadEvidence(instruction, prepared.file, (progress) =>
        setUploadState(prepared.key, { kind: 'uploading', progress }),
      );
      setUploadState(
        prepared.key,
        result.ok ? { kind: 'done' } : { kind: 'failed', message: uploadFailureMessage(result.error) },
      );
    },
    [deps, setUploadState],
  );

  const start = useCallback(
    (matched: ReadonlyArray<MatchedUpload>) => {
      setUploads(
        matched.map(([prepared, instruction]) => ({
          prepared,
          state: instruction
            ? { kind: 'uploading', progress: 0 }
            : { kind: 'failed', message: uploadFailureMessage('NO_MATCHING_UPLOAD') },
        })),
      );
      matched.forEach(([prepared, instruction]) => {
        if (instruction) void runUpload(prepared, instruction);
      });
    },
    [runUpload],
  );

  const retry = useCallback(
    async (prepared: PreparedFile) => {
      setUploadState(prepared.key, { kind: 'uploading', progress: 0 });
      const fresh = await freshUpload({ transactionId, file: prepared });
      if (!fresh.ok) {
        setUploadState(prepared.key, { kind: 'failed', message: uploadFailureMessage(fresh.error) });
        return;
      }
      await runUpload(prepared, fresh.value);
    },
    [freshUpload, runUpload, setUploadState, transactionId],
  );

  const allDone = uploads !== null && uploads.every((f) => f.state.kind === 'done');
  return { uploads, start, retry, allDone };
};
