import {
  EVIDENCE_VIEW_URL_TTL_SECONDS,
  evidenceDownloadFileName,
  type EvidenceViewRequest,
} from '@cd/dispute-domain';

export const attachmentDisposition = (request: EvidenceViewRequest): string =>
  `attachment; filename="${evidenceDownloadFileName(request.evidenceId, request.contentType)}"`;

export const expiryOf = (signedAt: Date): Date => new Date(signedAt.getTime() + EVIDENCE_VIEW_URL_TTL_SECONDS * 1000);

export const isPermittedUrl = (url: string, allowPlainHttp: boolean): boolean => {
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'https:' || (allowPlainHttp && protocol === 'http:');
};
