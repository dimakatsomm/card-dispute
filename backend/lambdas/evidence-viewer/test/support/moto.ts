import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { inject } from 'vitest';

export const REGION = 'eu-north-1';
export const MOTO_ENDPOINT = inject('motoEndpoint');

export const s3 = new S3Client({
  endpoint: MOTO_ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
});

export const makeBucket = async (cleanup: (fn: () => Promise<unknown>) => void, prefix: string): Promise<string> => {
  const Bucket = `${prefix}-${randomUUID().slice(0, 8)}`;
  await s3.send(new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: REGION } }));
  cleanup(async () => {
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket }));
    for (const { Key } of Contents) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    await s3.send(new DeleteBucketCommand({ Bucket }));
  });
  return Bucket;
};
