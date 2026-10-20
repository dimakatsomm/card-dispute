import { err, ok, type Result } from '@cd/shared/fp';
import { z } from 'zod';

export type Verdict = 'CLEAN' | 'MALWARE' | 'SCAN_FAILED' | 'NOT_SCANNED';

export type Trigger = {
  readonly eventId: string;
  readonly key: string;
  readonly transactionId: string;
  readonly evidenceId: string;
  readonly eTag: string | null;
  readonly verdict: Verdict;
};

export type TriggerError = 'INVALID_EVENT' | 'WRONG_BUCKET' | 'INVALID_KEY' | 'SCAN_REQUIRED';

export type TriggerPolicy = { readonly quarantineBucket: string; readonly requireScan: boolean };

// Envelopes stay non-strict: EventBridge and GuardDuty add fields over time; only what we act on is pinned.
const scanResultEvent = z.object({
  id: z.string().min(1),
  source: z.literal('aws.guardduty'),
  'detail-type': z.literal('GuardDuty Malware Protection Object Scan Result'),
  detail: z.object({
    scanStatus: z.enum(['COMPLETED', 'SKIPPED', 'FAILED']),
    resourceType: z.literal('S3_OBJECT'),
    s3ObjectDetails: z.object({
      bucketName: z.string().min(1),
      objectKey: z.string().min(1),
      eTag: z.string().nullish(),
    }),
    scanResultDetails: z.object({
      scanResultStatus: z.enum(['NO_THREATS_FOUND', 'THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED']),
    }),
  }),
});

const objectCreatedEvent = z.object({
  id: z.string().min(1),
  source: z.literal('aws.s3'),
  'detail-type': z.literal('Object Created'),
  detail: z.object({
    bucket: z.object({ name: z.string().min(1) }),
    object: z.object({ key: z.string().min(1), etag: z.string().nullish() }),
  }),
});

const intakeEvent = z.discriminatedUnion('source', [scanResultEvent, objectCreatedEvent]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INTAKE_KEY = new RegExp(`^intake/(${UUID})/(${UUID})$`);

export const normalizeETag = (eTag: string | null | undefined): string | null =>
  eTag ? eTag.replaceAll('"', '') : null;

type ScanStatus = z.infer<typeof scanResultEvent>['detail']['scanStatus'];
type ScanResultStatus = z.infer<typeof scanResultEvent>['detail']['scanResultDetails']['scanResultStatus'];

const scanVerdict = (scanStatus: ScanStatus, resultStatus: ScanResultStatus): Verdict => {
  if (resultStatus === 'THREATS_FOUND') return 'MALWARE';
  return scanStatus === 'COMPLETED' && resultStatus === 'NO_THREATS_FOUND' ? 'CLEAN' : 'SCAN_FAILED';
};

type Located = {
  readonly eventId: string;
  readonly bucket: string;
  readonly key: string;
  readonly eTag: string | null;
  readonly verdict: Verdict;
};

const locate = (event: z.infer<typeof intakeEvent>): Located =>
  event.source === 'aws.guardduty'
    ? {
        eventId: event.id,
        bucket: event.detail.s3ObjectDetails.bucketName,
        key: event.detail.s3ObjectDetails.objectKey,
        eTag: normalizeETag(event.detail.s3ObjectDetails.eTag),
        verdict: scanVerdict(event.detail.scanStatus, event.detail.scanResultDetails.scanResultStatus),
      }
    : {
        eventId: event.id,
        bucket: event.detail.bucket.name,
        key: event.detail.object.key,
        eTag: normalizeETag(event.detail.object.etag),
        verdict: 'NOT_SCANNED',
      };

export const parseTrigger = (event: unknown, policy: TriggerPolicy): Result<Trigger, TriggerError> => {
  const parsed = intakeEvent.safeParse(event);
  if (!parsed.success) return err('INVALID_EVENT');
  const located = locate(parsed.data);
  // The ETag ties a verdict to the exact bytes scanned; only the unscanned fallback has no verdict to tie.
  if (located.verdict !== 'NOT_SCANNED' && !located.eTag) return err('INVALID_EVENT');
  if (located.verdict === 'NOT_SCANNED' && policy.requireScan) return err('SCAN_REQUIRED');
  if (located.bucket !== policy.quarantineBucket) return err('WRONG_BUCKET');
  const match = INTAKE_KEY.exec(located.key);
  if (!match?.[1] || !match[2]) return err('INVALID_KEY');
  return ok({
    eventId: located.eventId,
    key: located.key,
    transactionId: match[1],
    evidenceId: match[2],
    eTag: located.eTag,
    verdict: located.verdict,
  });
};
