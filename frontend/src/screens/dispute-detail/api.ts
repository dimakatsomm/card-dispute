import type { ApiClient } from '../../api/client';
import type { components, operations } from '../../api/generated/disputes';
import { err, ok, type Result } from '../../app/result';

export type Dispute = components['schemas']['Dispute'];
export type DisputeDetail = operations['getDispute']['responses'][200]['content']['application/json'];
export type TimelineEvent = components['schemas']['TimelineEvent'];
export type Evidence = components['schemas']['Evidence'];

export type LoadedDispute = { readonly dispute: DisputeDetail; readonly etag: string };
export type LoadError = 'NOT_FOUND' | 'FAILED';

export type DisputeChange = operations['updateDispute']['requestBody']['content']['application/json'];

export type UpdateError = 'STALE' | 'INVALID_TRANSITION' | 'INVALID_INPUT' | 'NOT_FOUND' | 'FAILED';

const etagOf = (response: Response, version: number): string =>
  response.headers.get('ETag') ?? `"${version}"`;

export const loadDispute =
  (api: ApiClient) =>
  async (transactionId: string): Promise<Result<LoadedDispute, LoadError>> => {
    const { data, response } = await api.GET('/dispute/{transactionId}', {
      params: { path: { transactionId } },
    });
    if (data) return ok({ dispute: data, etag: etagOf(response, data.version) });
    return err(response.status === 404 ? 'NOT_FOUND' : 'FAILED');
  };

const updateErrorFor = (status: number): UpdateError => {
  switch (status) {
    case 412:
      return 'STALE';
    case 409:
      return 'INVALID_TRANSITION';
    case 400:
    case 422:
      return 'INVALID_INPUT';
    case 404:
      return 'NOT_FOUND';
    default:
      return 'FAILED';
  }
};

export const updateDispute =
  (api: ApiClient) =>
  async (input: {
    readonly transactionId: string;
    readonly etag: string;
    readonly change: DisputeChange;
  }): Promise<Result<Dispute, UpdateError>> => {
    const { data, response } = await api.PUT('/dispute/{transactionId}', {
      params: { path: { transactionId: input.transactionId }, header: { 'If-Match': input.etag } },
      body: input.change,
    });
    return data ? ok(data) : err(updateErrorFor(response.status));
  };
