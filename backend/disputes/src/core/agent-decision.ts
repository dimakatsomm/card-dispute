import type { DisputeAction, ResolutionOutcome } from '@cd/dispute-domain';

export type AgentDecision =
  | { readonly type: 'REVIEW' }
  | { readonly type: 'RESOLVE'; readonly outcome: ResolutionOutcome; readonly note: string };

export const toDomainAction = (decision: AgentDecision): DisputeAction =>
  decision.type === 'REVIEW' ? { type: 'REVIEW' } : { type: 'RESOLVE', outcome: decision.outcome };

// A replay carries the version its original change consumed (or the current one); a view older than that is stale.
export const isReplayVersion = (current: number, expected: number): boolean =>
  expected === current || expected === current - 1;
