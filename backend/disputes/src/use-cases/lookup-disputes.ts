import { ok, type Result } from '@cd/shared/fp';
import type { DisputeRef, LookupDisputeRefs } from './ports.ts';

export type LookupDisputesDeps = { readonly lookupRefs: LookupDisputeRefs };

export type LookupDisputesInput = {
  readonly userId: string;
  readonly transactionIds: ReadonlyArray<string>;
};

// Service port: answers from this service's own rows only and calls nobody, so transactions ↔ disputes cannot loop.
export const lookupDisputes =
  (deps: LookupDisputesDeps) =>
  async (input: LookupDisputesInput): Promise<Result<ReadonlyArray<DisputeRef>, never>> =>
    ok(await deps.lookupRefs(input.userId, input.transactionIds));
