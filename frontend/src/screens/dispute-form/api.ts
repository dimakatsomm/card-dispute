import type { ApiClient } from '../../api/client';
import { err, ok, type Result } from '../../app/result';
import { isUploadList, type UploadInstruction } from '../../components/evidence';
import type { CreateDisputeRequest, CreateFailure } from './core';

export type DisputeApi = {
  readonly createDispute: (
    transactionId: string,
    body: CreateDisputeRequest,
  ) => Promise<Result<ReadonlyArray<UploadInstruction>, CreateFailure>>;
};

const problemCode = (body: unknown): string | null =>
  typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : null;

const toCreateFailure = (status: number, body: unknown): CreateFailure => {
  switch (status) {
    case 409:
      return { kind: 'ALREADY_DISPUTED' };
    case 422:
      return { kind: 'NOT_ELIGIBLE', code: problemCode(body) };
    case 404:
      return { kind: 'NOT_FOUND' };
    case 400:
      return { kind: 'INVALID' };
    case 503:
      return { kind: 'UNAVAILABLE' };
    default:
      return { kind: 'UNEXPECTED' };
  }
};

export const createDisputeApi = (client: ApiClient): DisputeApi => ({
  createDispute: async (transactionId, body) => {
    try {
      const { data, error, response } = await client.POST('/dispute/{transactionId}', {
        params: { path: { transactionId } },
        body,
      });
      if (!data) return err(toCreateFailure(response.status, error));
      return isUploadList(data.uploads) ? ok(data.uploads) : err({ kind: 'UNEXPECTED' });
    } catch {
      return err({ kind: 'UNAVAILABLE' });
    }
  },
});
