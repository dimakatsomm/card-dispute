import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';

export const REGION = 'af-south-1';
const ENDPOINT = process.env['MOTO_ENDPOINT'] ?? 'http://localhost:55000';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

export const s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials, forcePathStyle: true });
export const sqs = new SQSClient({ endpoint: ENDPOINT, region: REGION, credentials });

export const uniqueName = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export type Cleanup = (fn: () => Promise<unknown>) => void;

export const makeBucket = async (cleanup: Cleanup): Promise<string> => {
  const Bucket = uniqueName('t-bucket');
  await s3.send(
    new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: REGION } }),
  );
  cleanup(async () => {
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket }));
    for (const { Key } of Contents) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    await s3.send(new DeleteBucketCommand({ Bucket }));
  });
  return Bucket;
};

export const makeQueue = async (
  cleanup: Cleanup,
  attributes: Record<string, string> = {},
): Promise<{ name: string; url: string }> => {
  const name = uniqueName('t-queue');
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  const url = QueueUrl ?? '';
  cleanup(() => sqs.send(new DeleteQueueCommand({ QueueUrl: url })));
  return { name, url };
};

export type FakeRie = {
  readonly url: string;
  readonly requests: unknown[];
  readonly close: () => Promise<void>;
};

export type RieAnswer = { readonly status?: number; readonly body: string };

export const startFakeRie = async (answer: (request: unknown, call: number) => RieAnswer): Promise<FakeRie> => {
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(parsed);
      const { status = 200, body } = answer(parsed, requests.length);
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/2015-03-31/functions/function/invocations`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
