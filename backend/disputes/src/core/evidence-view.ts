import { EVIDENCE_VIEW_RATE_LIMIT } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';

export const RETRY_AFTER_MIN_SECONDS = 1;
export const RETRY_AFTER_MAX_SECONDS = 600;

export type RecentViews = {
  readonly count: number;
  readonly secondsUntilOldestLeaves: number | null;
};

export type RateLimited = { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };

const clampRetryAfter = (seconds: number | null): number =>
  Math.min(
    RETRY_AFTER_MAX_SECONDS,
    Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil(seconds ?? RETRY_AFTER_MAX_SECONDS)),
  );

export const checkViewRateCap = (recent: RecentViews): Result<null, RateLimited> =>
  recent.count < EVIDENCE_VIEW_RATE_LIMIT.maxViews
    ? ok(null)
    : err({ kind: 'RATE_LIMITED', retryAfterSeconds: clampRetryAfter(recent.secondsUntilOldestLeaves) });
