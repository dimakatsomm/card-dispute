import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { inject } from 'vitest';

export const REGION = 'af-south-1';
const ENDPOINT = inject('motoEndpoint');

export const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
});

export type Cleanup = (fn: () => Promise<unknown>) => void;

export const makeBucket = async (cleanup: Cleanup, prefix: string): Promise<string> => {
  const Bucket = `${prefix}-${randomUUID().slice(0, 8)}`;
  await s3.send(new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: REGION } }));
  cleanup(async () => {
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket }));
    for (const { Key } of Contents) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    await s3.send(new DeleteBucketCommand({ Bucket }));
  });
  return Bucket;
};

export type Upload = {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly metadata?: Record<string, string>;
  readonly contentDisposition?: string;
  readonly withChecksum?: boolean;
};

// moto stores no checksum on PUT (verify-m2-00.md); a self-copy with SHA256 computes one, as the local scan stub does.
export const upload = async (u: Upload): Promise<string> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: u.bucket,
      Key: u.key,
      Body: u.body,
      ContentType: u.contentType,
      ...(u.metadata ? { Metadata: u.metadata } : {}),
      ...(u.contentDisposition ? { ContentDisposition: u.contentDisposition } : {}),
    }),
  );
  if (u.withChecksum !== false) {
    await s3.send(
      new CopyObjectCommand({
        Bucket: u.bucket,
        Key: u.key,
        CopySource: `${u.bucket}/${u.key}`,
        ChecksumAlgorithm: 'SHA256',
        MetadataDirective: 'REPLACE',
        ContentType: u.contentType,
        ...(u.metadata ? { Metadata: u.metadata } : {}),
        ...(u.contentDisposition ? { ContentDisposition: u.contentDisposition } : {}),
      }),
    );
  }
  const head = await s3.send(new HeadObjectCommand({ Bucket: u.bucket, Key: u.key }));
  return head.ETag ?? '';
};

export const exists = async (bucket: string, key: string): Promise<boolean> => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
};

export const keys = async (bucket: string): Promise<ReadonlyArray<string>> => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map((c) => c.Key ?? '');
};
