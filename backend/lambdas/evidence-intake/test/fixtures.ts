import { randomUUID } from 'node:crypto';

export type ScanStatus = 'COMPLETED' | 'SKIPPED' | 'FAILED';
export type ScanResultStatus = 'NO_THREATS_FOUND' | 'THREATS_FOUND' | 'UNSUPPORTED' | 'ACCESS_DENIED' | 'FAILED';

export type ObjectRef = { readonly bucket: string; readonly key: string; readonly eTag?: string };

export const intakeKey = (transactionId = randomUUID(), evidenceId = randomUUID()) => ({
  transactionId,
  evidenceId,
  key: `intake/${transactionId}/${evidenceId}`,
});

// Shape copied from the AWS GuardDuty user guide samples ("S3 object scan result").
export const scanResultEvent = (
  object: ObjectRef,
  resultStatus: ScanResultStatus = 'NO_THREATS_FOUND',
  scanStatus: ScanStatus = resultStatus === 'NO_THREATS_FOUND' || resultStatus === 'THREATS_FOUND'
    ? 'COMPLETED'
    : resultStatus === 'FAILED'
      ? 'FAILED'
      : 'SKIPPED',
) => ({
  version: '0',
  id: randomUUID(),
  'detail-type': 'GuardDuty Malware Protection Object Scan Result',
  source: 'aws.guardduty',
  account: '111122223333',
  time: '2026-10-20T10:00:00Z',
  region: 'eu-north-1',
  resources: ['arn:aws:guardduty:eu-north-1:111122223333:malware-protection-plan/b4c7f464ab3a4EXAMPLE'],
  detail: {
    schemaVersion: '1.0',
    scanStatus,
    resourceType: 'S3_OBJECT',
    s3ObjectDetails: {
      bucketName: object.bucket,
      objectKey: object.key,
      eTag: object.eTag ?? 'd41d8cd98f00b204e9800998ecf8427e',
      versionId: 'd41d8cd98f00b204e9800998eEXAMPLE',
      s3Throttled: false,
    },
    scanResultDetails: {
      scanResultStatus: resultStatus,
      threats:
        resultStatus === 'THREATS_FOUND'
          ? [
              {
                name: 'EICAR-Test-File (not a virus)',
                source: 'AMAZON',
                itemDetails: [{ hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', itemPath: object.key }],
              },
            ]
          : null,
      statusReasons: resultStatus === 'UNSUPPORTED' ? ['PASSWORD_PROTECTED'] : null,
    },
  },
});

// What local/lambda-driver's scan stub posts: no statusReasons, versionId null, threats without source/itemDetails.
export const driverScanEvent = (object: ObjectRef, verdict: 'NO_THREATS_FOUND' | 'THREATS_FOUND') => ({
  version: '0',
  id: randomUUID(),
  'detail-type': 'GuardDuty Malware Protection Object Scan Result',
  source: 'aws.guardduty',
  account: '000000000000',
  time: '2026-10-20T10:00:00.000Z',
  region: 'eu-north-1',
  resources: ['arn:aws:guardduty:eu-north-1:000000000000:malware-protection-plan/local-stub'],
  detail: {
    schemaVersion: '1.0',
    scanStatus: 'COMPLETED',
    resourceType: 'S3_OBJECT',
    s3ObjectDetails: { bucketName: object.bucket, objectKey: object.key, eTag: object.eTag, versionId: null, s3Throttled: false },
    scanResultDetails: {
      scanResultStatus: verdict,
      threats: verdict === 'THREATS_FOUND' ? [{ name: 'Eicar-Test-Signature' }] : null,
    },
  },
});

// EventBridge "Object Created" from S3 (the V-03 fallback trigger).
export const objectCreatedEvent = (object: ObjectRef) => ({
  version: '0',
  id: randomUUID(),
  'detail-type': 'Object Created',
  source: 'aws.s3',
  account: '111122223333',
  time: '2026-10-20T10:00:00Z',
  region: 'eu-north-1',
  resources: [`arn:aws:s3:::${object.bucket}`],
  detail: {
    version: '0',
    bucket: { name: object.bucket },
    object: { key: object.key, size: 1024, etag: object.eTag ?? 'd41d8cd98f00b204e9800998ecf8427e', sequencer: '0062E99A88DC407460' },
    'request-id': 'N4N7GDK58NMKJ12R',
    requester: '111122223333',
    'source-ip-address': '203.0.113.15',
    reason: 'PutObject',
  },
});

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
export const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
export const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
export const SHA_HEX = 'a'.repeat(64);
