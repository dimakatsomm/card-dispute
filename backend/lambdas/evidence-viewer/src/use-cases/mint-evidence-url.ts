import {
  EVIDENCE_VIEW_URL_TTL_SECONDS,
  evidenceObjectKey,
  evidenceViewRequestSchema,
  evidenceViewResponseSchema,
  type EvidenceViewResponse,
} from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { attachmentDisposition, expiryOf, isPermittedUrl } from '../core/evidence-url.ts';

export type PresignRequest = {
  readonly key: string;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly signedAt: Date;
  readonly expiresInSeconds: number;
};

export type IssueRef = { readonly path: string; readonly code: string };

export type MintError =
  | { readonly kind: 'invalid_request'; readonly issues: ReadonlyArray<IssueRef> }
  | { readonly kind: 'invalid_clock' }
  | { readonly kind: 'insecure_url' }
  | { readonly kind: 'invalid_response' };

export type MintDeps = {
  readonly presign: (request: PresignRequest) => Promise<string>;
  readonly now: () => Date;
  readonly allowPlainHttp: boolean;
  readonly log: { readonly info: (obj: object, msg: string) => void };
};

export const mintEvidenceUrl =
  (deps: MintDeps) =>
  async (event: unknown): Promise<Result<EvidenceViewResponse, MintError>> => {
    const parsed = evidenceViewRequestSchema.safeParse(event);
    if (!parsed.success) {
      return err({
        kind: 'invalid_request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code })),
      });
    }
    const request = parsed.data;
    // SigV4 dates have whole seconds; flooring keeps expiresAt equal to the URL's real expiry.
    const signedAt = new Date(Math.floor(deps.now().getTime() / 1000) * 1000);
    if (Number.isNaN(signedAt.getTime())) return err({ kind: 'invalid_clock' });

    const url = await deps.presign({
      key: evidenceObjectKey(request.disputeId, request.evidenceId),
      contentType: request.contentType,
      contentDisposition: attachmentDisposition(request),
      signedAt,
      expiresInSeconds: EVIDENCE_VIEW_URL_TTL_SECONDS,
    });
    if (!isPermittedUrl(url, deps.allowPlainHttp)) return err({ kind: 'insecure_url' });

    const response = evidenceViewResponseSchema.safeParse({ url, expiresAt: expiryOf(signedAt).toISOString() });
    if (!response.success) return err({ kind: 'invalid_response' });

    deps.log.info(
      { disputeId: request.disputeId, evidenceId: request.evidenceId, correlationId: request.correlationId },
      'evidence url minted',
    );
    return ok(response.data);
  };
