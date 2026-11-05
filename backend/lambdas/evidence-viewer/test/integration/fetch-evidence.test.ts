import { PutObjectCommand } from '@aws-sdk/client-s3';
import { evidenceObjectKey } from '@cd/dispute-domain';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { configSchema } from '../../src/config.ts';
import { compose } from '../../src/main.ts';
import { DISPUTE_ID, EVIDENCE_ID, capturedLog, validRequest } from '../support/harness.ts';
import { MOTO_ENDPOINT, makeBucket, s3 } from '../support/moto.ts';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

let cleanups: Array<() => Promise<unknown>> = [];
let bucket: string;

beforeEach(async () => {
  cleanups = [];
  bucket = await makeBucket((fn) => cleanups.push(fn), 't-evidence');
});

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

it('mints a URL that fetches the stored object as a no-store attachment', async () => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: evidenceObjectKey(DISPUTE_ID, EVIDENCE_ID),
      Body: PNG_BYTES,
      ContentType: 'application/octet-stream',
      ContentDisposition: 'inline; filename="jane-doe-id.png"',
    }),
  );
  const config = configSchema.parse({ AWS_REGION: 'eu-north-1', EVIDENCE_BUCKET: bucket, AWS_ENDPOINT_URL: MOTO_ENDPOINT });
  const handler = compose(config, { s3, now: () => new Date(), log: capturedLog().log });

  const { url } = await handler({ ...validRequest, contentType: 'image/png' });
  const response = await fetch(url);

  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${EVIDENCE_ID}.png"`);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
