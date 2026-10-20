import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Config } from './config.ts';

export const makeS3 = (config: Config): S3Client =>
  new S3Client({ endpoint: config.AWS_ENDPOINT_URL, region: config.AWS_REGION, forcePathStyle: true });

export const makeSqs = (config: Config): SQSClient =>
  new SQSClient({ endpoint: config.AWS_ENDPOINT_URL, region: config.AWS_REGION });
