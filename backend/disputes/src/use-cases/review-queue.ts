import { ok, type Result } from '@cd/shared/fp';
import { queueReviewerIds, toQueuePage, type QueueStatus } from '../core/agent-view.ts';
import { decodeQueueCursor, type CursorError } from '../core/cursor.ts';
import type { ReviewQueuePage } from '../core/types.ts';
import { namesOrNone } from './agent-dispute.ts';
import type { ListReviewQueue, ResolveAgentNames } from './ports.ts';

export type ReviewQueueDeps = {
  readonly listReviewQueue: ListReviewQueue;
  readonly resolveAgentNames: ResolveAgentNames;
};

export type ReviewQueueInput = {
  readonly statuses: ReadonlyArray<QueueStatus>;
  readonly limit: number;
  readonly cursor?: string | undefined;
};

export const listReviewQueue =
  (deps: ReviewQueueDeps) =>
  async (input: ReviewQueueInput): Promise<Result<ReviewQueuePage, CursorError>> => {
    const after = input.cursor === undefined ? ok(null) : decodeQueueCursor(input.cursor);
    if (!after.ok) return after;
    const rows = await deps.listReviewQueue({
      statuses: input.statuses,
      after: after.value,
      limit: input.limit + 1,
    });
    const names = await namesOrNone(deps.resolveAgentNames, queueReviewerIds(rows.slice(0, input.limit)));
    return ok(toQueuePage(rows, input.limit, names));
  };
