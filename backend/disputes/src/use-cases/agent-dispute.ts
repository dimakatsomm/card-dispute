import { err, ok, type Result } from '@cd/shared/fp';
import { agentActorIds, toAgentDetail, type AgentNames } from '../core/agent-view.ts';
import { toTransactionRef } from '../core/dispute.ts';
import type { AgentDisputeDetail, Transaction } from '../core/types.ts';
import type {
  EvidenceDigest,
  FindForAgent,
  FindTransaction,
  ResolveAgentNames,
  UpstreamError,
} from './ports.ts';

export type AgentDisputeDeps = {
  readonly findForAgent: FindForAgent;
  readonly findTransaction: FindTransaction;
  readonly resolveAgentNames: ResolveAgentNames;
  readonly evidenceDigest: EvidenceDigest;
};

export type GetAgentDisputeInput = { readonly transactionId: string; readonly correlationId: string };

export type GetAgentDisputeError = 'NOT_FOUND';

const NO_NAMES: AgentNames = new Map();

// Names are enrichment: an unreachable directory blanks them but never the dispute.
export const namesOrNone = (resolve: ResolveAgentNames, ids: ReadonlyArray<string>): Promise<AgentNames> =>
  ids.length === 0 ? Promise.resolve(NO_NAMES) : resolve(ids).catch(() => NO_NAMES);

export const getAgentDispute =
  (deps: AgentDisputeDeps) =>
  async (input: GetAgentDisputeInput): Promise<Result<AgentDisputeDetail, GetAgentDisputeError>> => {
    const found = await deps.findForAgent(input.transactionId);
    if (found === null) return err('NOT_FOUND');
    // The owner comes from the stored dispute, never from the agent's request (ADR-071).
    const [txn, names] = await Promise.all([
      deps
        .findTransaction(found.dispute.userId, found.dispute.transactionId, input.correlationId)
        .catch((): Result<Transaction | null, UpstreamError> => err('UPSTREAM_UNAVAILABLE')),
      namesOrNone(deps.resolveAgentNames, agentActorIds(found.history)),
    ]);
    return ok(
      toAgentDetail({
        ...found,
        transaction: txn.ok && txn.value !== null ? toTransactionRef(txn.value) : null,
        names,
        evidenceDigest: deps.evidenceDigest(found.evidence),
      }),
    );
  };
