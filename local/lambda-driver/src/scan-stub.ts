import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
  paginateListObjectsV2,
  type S3Client,
} from '@aws-sdk/client-s3';
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EICAR } from './eicar.ts';
import type { Invoke } from './rie.ts';

export const SCAN_TAG = 'GuardDutyMalwareScanStatus';
const ATTEMPTS = 3;

export type ScanStubDeps = {
  readonly s3: S3Client;
  readonly sqs: SQSClient;
  readonly invoke: Invoke;
  readonly now: () => Date;
  readonly bucket: string;
  readonly region: string;
  readonly intakeUrl: string;
  readonly dlqName: string;
  readonly retryDelayMs: number;
};

type Verdict = 'THREATS_FOUND' | 'NO_THREATS_FOUND';

const buildScanEvent = (
  deps: ScanStubDeps,
  object: { readonly key: string; readonly eTag: string | undefined },
  verdict: Verdict,
) => ({
  version: '0',
  id: randomUUID(),
  'detail-type': 'GuardDuty Malware Protection Object Scan Result',
  source: 'aws.guardduty',
  account: '000000000000',
  time: deps.now().toISOString(),
  region: deps.region,
  resources: [`arn:aws:guardduty:${deps.region}:000000000000:malware-protection-plan/local-stub`],
  detail: {
    schemaVersion: '1.0',
    scanStatus: 'COMPLETED',
    resourceType: 'S3_OBJECT',
    s3ObjectDetails: {
      bucketName: deps.bucket,
      objectKey: object.key,
      eTag: object.eTag?.replaceAll('"', ''),
      versionId: null,
      s3Throttled: false,
    },
    scanResultDetails: {
      scanResultStatus: verdict,
      threats: verdict === 'THREATS_FOUND' ? [{ name: 'Eicar-Test-Signature' }] : null,
    },
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Emulates EventBridge async invoke: 2 retries, then the original event goes to the DLQ.
const deliver = async (deps: ScanStubDeps, event: unknown): Promise<void> => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = await deps.invoke(deps.intakeUrl, event);
    if (result.ok) return;
    console.warn(`scan-stub: intake attempt ${attempt}/${ATTEMPTS} failed: ${result.reason}`);
    if (attempt < ATTEMPTS) await sleep(deps.retryDelayMs);
  }
  const { QueueUrl } = await deps.sqs.send(new GetQueueUrlCommand({ QueueName: deps.dlqName }));
  await deps.sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(event) }));
  console.warn(`scan-stub: event moved to ${deps.dlqName}`);
};

const scanObject = async (deps: ScanStubDeps, key: string): Promise<boolean> => {
  const { s3, bucket } = deps;
  const { TagSet = [] } = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
  if (TagSet.some((tag) => tag.Key === SCAN_TAG)) return false;

  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const { ContentType, Metadata } = object;
  const bytes = await object.Body?.transformToByteArray();
  const verdict: Verdict = bytes && Buffer.from(bytes).includes(EICAR) ? 'THREATS_FOUND' : 'NO_THREATS_FOUND';

  // moto stores no checksum on PUT; a self-copy computes one from the stored bytes (REPLACE: S3 refuses a no-op self-copy).
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: `${bucket}/${encodeURIComponent(key).replaceAll('%2F', '/')}`,
      ChecksumAlgorithm: 'SHA256',
      MetadataDirective: 'REPLACE',
      ...(ContentType ? { ContentType } : {}),
      ...(Metadata ? { Metadata } : {}),
    }),
  );
  await s3.send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      Tagging: { TagSet: [...TagSet, { Key: SCAN_TAG, Value: verdict }] },
    }),
  );
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  await deliver(deps, buildScanEvent(deps, { key, eTag: head.ETag }, verdict));
  return true;
};

export const scanOnce = async (deps: ScanStubDeps): Promise<number> => {
  const keys: string[] = [];
  for await (const page of paginateListObjectsV2({ client: deps.s3 }, { Bucket: deps.bucket })) {
    for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
  }
  let scanned = 0;
  for (const key of keys) if (await scanObject(deps, key)) scanned += 1;
  return scanned;
};
