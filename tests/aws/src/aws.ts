import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from './env.ts';

const once = <T>(make: (region: string) => T): (() => T) => {
  let client: T | undefined;
  return () => (client ??= make(env().region));
};

export const cognito = once((region) => new CognitoIdentityProviderClient({ region }));
export const secrets = once((region) => new SecretsManagerClient({ region }));
export const s3 = once((region) => new S3Client({ region }));
export const sqs = once((region) => new SQSClient({ region }));
export const cloudwatch = once((region) => new CloudWatchClient({ region }));
export const ec2 = once((region) => new EC2Client({ region }));
export const ecs = once((region) => new ECSClient({ region }));

export const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'UnknownError');

export const httpStatus = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
