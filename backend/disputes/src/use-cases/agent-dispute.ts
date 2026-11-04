import { err, ok, type Result } from '@cd/shared/fp';
import { toAgentDetail } from '../core/agent-view.ts';
import { toTransactionRef } from '../core/dispute.ts';
import type { AgentDisputeDetail, Transaction } from '../core/types.ts';
import type { EvidenceDigest, FindForAgent, FindTransaction, UpstreamError } from './ports.ts';

export type AgentDisputeDeps = {
  readonly findForAgent: FindForAgent;
  readonly findTransaction: FindTransaction;
  readonly evidenceDigest: EvidenceDigest;
};

export type GetAgentDisputeInput = { readonly transactionId: string; readonly correlationId: string };

export type GetAgentDisputeError = 'NOT_FOUND';

export const getAgentDispute =
  (deps: AgentDisputeDeps) =>
  async (input: GetAgentDisputeInput): Promise<Result<AgentDisputeDetail, GetAgentDisputeError>> => {
    const found = await deps.findForAgent(input.transactionId);
    if (found === null) return err('NOT_FOUND');
    // The owner comes from the stored dispute, never from the agent's request (ADR-071).
    const txn: Result<Transaction | null, UpstreamError> = await deps
      .findTransaction(found.dispute.userId, found.dispute.transactionId, input.correlationId)
      .catch(() => err('UPSTREAM_UNAVAILABLE'));
    return ok(
      toAgentDetail({
        ...found,
        transaction: txn.ok && txn.value !== null ? toTransactionRef(txn.value) : null,
        evidenceDigest: deps.evidenceDigest(found.evidence),
      }),
    );
  };
