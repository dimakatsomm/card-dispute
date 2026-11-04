import type { ApiClient } from '../../api/client';
import type { components } from '../../api/generated/disputes';
import { err, ok, type Result } from '../../app/result';
import type { QueueStatus } from './labels';

export type QueueItem = components['schemas']['QueueItem'];

export type QueuePage = {
  readonly items: ReadonlyArray<QueueItem>;
  readonly nextCursor: string | null;
};

export type QueueError = 'FAILED';

export const listReviewQueue =
  (api: ApiClient) =>
  async (input: { readonly status: QueueStatus | null; readonly cursor: string | undefined }): Promise<
    Result<QueuePage, QueueError>
  > => {
    const { data } = await api.GET('/agent/review-queue', {
      params: {
        query: {
          ...(input.status ? { status: [input.status] } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      },
    });
    return data ? ok(data) : err('FAILED');
  };
