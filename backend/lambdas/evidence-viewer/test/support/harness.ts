import { S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '@cd/shared/lambda';
import { configSchema } from '../../src/config.ts';
import { compose, type Runtime } from '../../src/main.ts';

export const NOW = new Date('2026-11-05T10:00:00.000Z');
export const DISPUTE_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const EVIDENCE_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
export const BUCKET = 'cd-dev-evidence';

export const validRequest = {
  disputeId: DISPUTE_ID,
  evidenceId: EVIDENCE_ID,
  contentType: 'application/pdf',
  correlationId: 'corr-0123456789',
} as const;

export const capturedLog = () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', destination: { write: (line: string) => lines.push(line) } });
  return {
    log,
    text: () => lines.join('\n'),
    entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
};

export const staticS3 = (endpoint?: string) =>
  new S3Client({
    region: 'eu-north-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    ignoreConfiguredEndpointUrls: true,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });

export const viewer = (env: Record<string, string> = {}, runtime: Partial<Runtime> = {}) => {
  const captured = capturedLog();
  const config = configSchema.parse({ AWS_REGION: 'eu-north-1', EVIDENCE_BUCKET: BUCKET, ...env });
  const handler = compose(config, {
    s3: staticS3(config.AWS_ENDPOINT_URL),
    now: () => NOW,
    log: captured.log,
    ...runtime,
  });
  return { handler, ...captured };
};
