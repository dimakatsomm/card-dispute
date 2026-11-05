import { z } from 'zod';
import { EVIDENCE_CONTENT_TYPES, type EvidenceContentType } from './evidence.ts';

export const EVIDENCE_VIEW_URL_TTL_SECONDS = 60;
export const EVIDENCE_VIEW_RATE_LIMIT = Object.freeze({ maxViews: 30, windowMinutes: 10 });

const EXTENSIONS: Readonly<Record<EvidenceContentType, string>> = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
});

export const evidenceObjectKey = (disputeId: string, evidenceId: string): string =>
  `evidence/${disputeId}/${evidenceId}`;

// Never the customer's file name: it is untrusted and may hold PII.
export const evidenceDownloadFileName = (evidenceId: string, contentType: EvidenceContentType): string =>
  `${evidenceId}.${EXTENSIONS[contentType]}`;

// z.guid, not z.uuid: seeded ids are not RFC 9562 version-tagged (same as @cd/contracts).
export const evidenceViewRequestSchema = z
  .strictObject({
    disputeId: z.guid(),
    evidenceId: z.guid(),
    contentType: z.enum(EVIDENCE_CONTENT_TYPES),
    correlationId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  })
  .readonly();
export type EvidenceViewRequest = z.infer<typeof evidenceViewRequestSchema>;

export const evidenceViewResponseSchema = z
  .strictObject({
    url: z.url({ protocol: /^https?$/ }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .readonly();
export type EvidenceViewResponse = z.infer<typeof evidenceViewResponseSchema>;
