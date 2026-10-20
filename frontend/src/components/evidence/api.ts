import type { ApiClient } from '../../api/client';
import { err, ok, type Result } from '../../app/result';
import type { EvidenceDeclaration, EvidenceFailure, UploadInstruction } from './core';

export type EvidenceApi = {
  readonly addEvidence: (
    transactionId: string,
    evidence: ReadonlyArray<EvidenceDeclaration>,
  ) => Promise<Result<ReadonlyArray<UploadInstruction>, EvidenceFailure>>;
};

const toEvidenceFailure = (status: number): EvidenceFailure => {
  switch (status) {
    case 409:
      return 'CLOSED';
    case 413:
      return 'TOO_MANY_FILES';
    case 404:
      return 'NOT_FOUND';
    case 503:
      return 'UNAVAILABLE';
    default:
      return 'UNEXPECTED';
  }
};

export const isUploadList = (value: unknown): value is ReadonlyArray<UploadInstruction> =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      'url' in item &&
      typeof item.url === 'string' &&
      'headers' in item &&
      typeof item.headers === 'object' &&
      item.headers !== null,
  );

export const createEvidenceApi = (client: ApiClient): EvidenceApi => ({
  addEvidence: async (transactionId, evidence) => {
    try {
      const { data, response } = await client.POST('/dispute/{transactionId}/evidence', {
        params: { path: { transactionId } },
        body: { evidence: [...evidence] },
      });
      if (!data) return err(toEvidenceFailure(response.status));
      return isUploadList(data.uploads) ? ok(data.uploads) : err('UNEXPECTED');
    } catch {
      return err('UNAVAILABLE');
    }
  },
});
