import type { Result } from '@cd/shared/fp';
import type { SweepError, SweepSummary } from './use-cases/sweep-retention.ts';

export type HandlerDeps = {
  readonly sweep: (now: Date) => Promise<Result<SweepSummary, SweepError>>;
  readonly now: () => Date;
};

const describeError = (error: SweepError): string => {
  switch (error.kind) {
    case 'invalid_clock':
      return 'retention-sweeper clock returned an invalid date';
    case 'wrong_role':
      return `retention-sweeper must connect as disputes_retention, not ${error.actual}`;
    case 'erase_failed':
      return `retention-sweeper failed to erase ${error.failedDisputeIds.length} dispute(s)`;
  }
};

// The schedule event is deliberately ignored: only the injected clock decides what is due.
export const createHandler =
  (deps: HandlerDeps) =>
  async (): Promise<SweepSummary> => {
    const result = await deps.sweep(deps.now());
    if (result.ok) return result.value;
    // Throwing marks the invocation failed so the async retry, DLQ and error alarm see it.
    throw new Error(describeError(result.error));
  };
