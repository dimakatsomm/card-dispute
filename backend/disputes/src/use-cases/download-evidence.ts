import { EVIDENCE_VIEW_RATE_LIMIT, type EvidenceViewResponse } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { checkViewRateCap, type RateLimited } from '../core/evidence-view.ts';
import type { EvidenceForAgent, FindEvidenceForAgent, InvokeViewer, Transact } from './ports.ts';

export type DownloadEvidenceDeps = {
  readonly findEvidenceForAgent: FindEvidenceForAgent;
  readonly transact: Transact;
  readonly invokeViewer: InvokeViewer;
};

export type DownloadEvidenceInput = {
  readonly agentId: string;
  readonly transactionId: string;
  readonly evidenceId: string;
  readonly correlationId: string;
};

export type DownloadEvidenceError =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'EVIDENCE_NOT_STORED'; readonly disputeId: string }
  | (RateLimited & { readonly disputeId: string })
  | { readonly kind: 'AUDIT_UNAVAILABLE'; readonly disputeId: string }
  | { readonly kind: 'VIEWER_UNAVAILABLE'; readonly disputeId: string };

export type EvidenceDownload = { readonly disputeId: string; readonly link: EvidenceViewResponse };

// Count and insert under one per-agent lock, so concurrent requests cannot overshoot the cap.
const recordView = (deps: DownloadEvidenceDeps, agentId: string, item: EvidenceForAgent) =>
  deps.transact<null, RateLimited>(async (tx) => {
    await tx.lockAgentViews(agentId);
    const capped = checkViewRateCap(await tx.recentViews(agentId, EVIDENCE_VIEW_RATE_LIMIT.windowMinutes));
    if (!capped.ok) return capped;
    await tx.insertEvidenceView({
      evidenceRowId: item.evidenceRowId,
      disputeRowId: item.disputeRowId,
      agentId,
    });
    return ok(null);
  });

export const downloadEvidence =
  (deps: DownloadEvidenceDeps) =>
  async (input: DownloadEvidenceInput): Promise<Result<EvidenceDownload, DownloadEvidenceError>> => {
    const item = await deps.findEvidenceForAgent(input.transactionId, input.evidenceId);
    if (item === null) return err({ kind: 'NOT_FOUND' });
    const { disputeId } = item;
    if (item.status !== 'STORED') return err({ kind: 'EVIDENCE_NOT_STORED', disputeId });

    // Fail closed: no audit row, no link.
    const recorded = await recordView(deps, input.agentId, item).catch(() =>
      err({ kind: 'AUDIT_UNAVAILABLE' as const }),
    );
    if (!recorded.ok) return err({ ...recorded.error, disputeId });

    const link = await deps.invokeViewer({
      disputeId,
      evidenceId: input.evidenceId,
      contentType: item.contentType,
      correlationId: input.correlationId,
    });
    return link.ok ? ok({ disputeId, link: link.value }) : err({ kind: link.error, disputeId });
  };
