import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { ResourceNotFoundException, type GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createLogger, type SecretsClient } from '@cd/shared/lambda';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.ts';
import { compose } from '../../src/main.ts';
import { DISPUTE_ID, recordAsReported, startDisputesStub, type DisputesStub } from '../support/disputes-stub.ts';
import { exists, keys, makeBucket, s3, upload } from '../support/moto.ts';
import { EXE_BYTES, PDF_BYTES, intakeKey, objectCreatedEvent, scanResultEvent } from '../fixtures.ts';

const FILE_NAME = 'jane-doe-statement-4111.pdf';
const CLIENT_SECRET = 'local-client-secret';

let cleanups: Array<() => Promise<unknown>> = [];
let stub: DisputesStub;
let quarantine: string;
let evidence: string;

beforeEach(async () => {
  cleanups = [];
  stub = await startDisputesStub();
  cleanups.push(() => stub.close());
  quarantine = await makeBucket((fn) => cleanups.push(fn), 't-quarantine');
  evidence = await makeBucket((fn) => cleanups.push(fn), 't-evidence');
});

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

type Setup = {
  readonly env?: Record<string, string>;
  readonly secrets?: SecretsClient;
  readonly timeoutMs?: number;
};

const setup = async ({ env = {}, secrets, timeoutMs }: Setup = {}) => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', destination: { write: (line: string) => lines.push(line) } });
  const config = configSchema.parse({
    AWS_REGION: 'eu-north-1',
    QUARANTINE_BUCKET: quarantine,
    EVIDENCE_BUCKET: evidence,
    DISPUTES_SERVICE_URL: `${stub.url}/`,
    TOKEN_URL: stub.tokenUrl,
    SERVICE_CLIENT_ID: 'svc-evidence-intake',
    ...(secrets ? { SERVICE_CLIENT_SECRET_ID: 'cd/dev/svc-evidence-intake' } : { SERVICE_CLIENT_SECRET: CLIENT_SECRET }),
    ...env,
  });
  const handler = await compose(config, {
    s3,
    secrets: () => secrets ?? { send: () => Promise.reject(new Error('Secrets Manager must not be used')) },
    fetch: globalThis.fetch,
    now: () => new Date(),
    newId: randomUUID,
    log,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { handler, logs: () => lines.join('\n') };
};

const uploadPdf = async (options: { readonly withChecksum?: boolean } = {}) => {
  const ids = intakeKey();
  const eTag = await upload({
    bucket: quarantine,
    key: ids.key,
    body: PDF_BYTES,
    contentType: 'application/pdf',
    metadata: { filename: FILE_NAME },
    contentDisposition: `attachment; filename="${FILE_NAME}"`,
    ...options,
  });
  return { ...ids, eTag, event: scanResultEvent({ bucket: quarantine, key: ids.key, eTag }) };
};

const scanResultEventWithoutETag = (bucket: string, key: string) => {
  const event = scanResultEvent({ bucket, key });
  const details = Object.fromEntries(Object.entries(event.detail.s3ObjectDetails).filter(([name]) => name !== 'eTag'));
  return { ...event, detail: { ...event.detail, s3ObjectDetails: details } };
};

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('evidence-intake on moto with a disputes stub', () => {
  it('clean PDF: PUTs STORED facts with a service token, copies to the s3Key without client metadata, deletes; logs carry no file name', async () => {
    const { handler, logs } = await setup();
    const { key, transactionId, evidenceId, event } = await uploadPdf();

    expect(await handler(event)).toEqual({ outcome: 'PROMOTED' });

    const [put] = stub.puts();
    expect(stub.puts()).toHaveLength(1);
    expect(put?.method).toBe('PUT');
    expect(put?.path).toBe(`/dispute/${transactionId}/evidence/${evidenceId}`);
    expect(put?.headers.authorization).toBe('Bearer token-1');
    expect(put?.headers['x-correlation-id']).toBe(event.id);
    expect(put?.body).toEqual({ result: 'STORED', sha256: sha256Hex(PDF_BYTES), sizeBytes: PDF_BYTES.length, contentType: 'application/pdf' });

    const [token] = stub.tokenRequests();
    expect(new URLSearchParams(String(token?.body)).get('scope')).toBe('disputes/evidence.write');
    expect(token?.headers.authorization).toBe(`Basic ${Buffer.from(`svc-evidence-intake:${CLIENT_SECRET}`).toString('base64')}`);

    const s3Key = `evidence/${DISPUTE_ID}/${evidenceId}`;
    expect(await keys(evidence)).toEqual([s3Key]);
    const stored = await s3.send(new GetObjectCommand({ Bucket: evidence, Key: s3Key }));
    expect(await stored.Body?.transformToByteArray()).toEqual(PDF_BYTES);
    expect(stored.ContentType).toBe('application/pdf');
    expect(stored.Metadata).toEqual({});
    expect(stored.ContentDisposition).toBeUndefined();
    const { TagSet } = await s3.send(new GetObjectTaggingCommand({ Bucket: evidence, Key: s3Key }));
    expect(TagSet).toEqual([]);
    expect(await exists(quarantine, key)).toBe(false);

    expect(logs()).toContain(evidenceId);
    expect(logs()).not.toContain(FILE_NAME);
    expect(logs()).not.toContain('jane');
    expect(logs()).not.toContain(CLIENT_SECRET);
    expect(logs()).not.toContain('token-1');
  });

  it('duplicate delivery is processed once: the second event finds no object and succeeds without a PUT', async () => {
    const { handler } = await setup();
    const { event, evidenceId } = await uploadPdf();

    expect(await handler(event)).toEqual({ outcome: 'PROMOTED' });
    expect(await handler(event)).toEqual({ outcome: 'ALREADY_PROCESSED' });

    expect(stub.puts()).toHaveLength(1);
    expect(await keys(evidence)).toEqual([`evidence/${DISPUTE_ID}/${evidenceId}`]);
  });

  it('renamed exe declared as PDF: REJECTED TYPE_MISMATCH, never copied, deleted', async () => {
    const { handler } = await setup();
    const { key } = intakeKey();
    const eTag = await upload({ bucket: quarantine, key, body: EXE_BYTES, contentType: 'application/pdf' });

    expect(await handler(scanResultEvent({ bucket: quarantine, key, eTag }))).toEqual({ outcome: 'REJECTED' });

    expect(stub.puts()[0]?.body).toMatchObject({ result: 'REJECTED', reason: 'TYPE_MISMATCH', sizeBytes: EXE_BYTES.length });
    expect(await keys(evidence)).toEqual([]);
    expect(await exists(quarantine, key)).toBe(false);
  });

  it('an object without a stored SHA-256 checksum is REJECTED CHECKSUM', async () => {
    const { handler } = await setup();
    const { key, event } = await uploadPdf({ withChecksum: false });

    expect(await handler(event)).toEqual({ outcome: 'REJECTED' });

    expect(stub.puts()[0]?.body).toMatchObject({ result: 'REJECTED', reason: 'CHECKSUM' });
    expect(stub.puts()[0]?.body).not.toHaveProperty('sha256');
    expect(await keys(evidence)).toEqual([]);
    expect(await exists(quarantine, key)).toBe(false);
  });

  it('THREATS_FOUND: REJECTED MALWARE without facts, deleted', async () => {
    const { handler } = await setup();
    const { key, eTag } = await uploadPdf();

    expect(await handler(scanResultEvent({ bucket: quarantine, key, eTag }, 'THREATS_FOUND'))).toEqual({ outcome: 'REJECTED' });

    expect(stub.puts()[0]?.body).toEqual({ result: 'REJECTED', reason: 'MALWARE' });
    expect(await keys(evidence)).toEqual([]);
    expect(await exists(quarantine, key)).toBe(false);
  });

  it('disputes answering REJECTED to a claimed STORED: nothing copied, deleted', async () => {
    const { handler } = await setup();
    const { key, evidenceId, event } = await uploadPdf();
    stub.reply(() => ({ status: 200, body: { evidenceId, status: 'REJECTED' } }));

    expect(await handler(event)).toEqual({ outcome: 'REJECTED' });

    expect(stub.puts()[0]?.body).toMatchObject({ result: 'STORED' });
    expect(await keys(evidence)).toEqual([]);
    expect(await exists(quarantine, key)).toBe(false);
  });

  it.each([
    ['another bucket', (key: string) => scanResultEvent({ bucket: evidence, key })],
    ['a key outside intake/{uuid}/{uuid}', () => scanResultEvent({ bucket: quarantine, key: 'intake/receipt.pdf' })],
    ['garbage', () => ({ detail: 'nope' })],
    ['a scanned CLEAN event without an eTag', (key: string) => scanResultEventWithoutETag(quarantine, key)],
  ])('poison (%s): throws for the DLQ and calls nothing', async (_name, makeEvent) => {
    const { handler } = await setup();
    const { key } = await uploadPdf();

    await expect(handler(makeEvent(key))).rejects.toThrow(/evidence intake failed/);

    expect(stub.puts()).toEqual([]);
    expect(stub.tokenRequests()).toEqual([]);
    expect(await exists(quarantine, key)).toBe(true);
  });

  it('disputes 5xx throws and keeps the object; the retry after recovery promotes it', async () => {
    const { handler } = await setup();
    const { key, evidenceId, event } = await uploadPdf();
    stub.reply(() => ({ status: 503, body: { code: 'UNAVAILABLE' } }));

    await expect(handler(event)).rejects.toThrow('DISPUTES_UNAVAILABLE');
    expect(await exists(quarantine, key)).toBe(true);
    expect(await keys(evidence)).toEqual([]);

    stub.reply(recordAsReported);
    expect(await handler(event)).toEqual({ outcome: 'PROMOTED' });
    expect(await keys(evidence)).toEqual([`evidence/${DISPUTE_ID}/${evidenceId}`]);
  });

  it('disputes timeout throws within the deadline and keeps the object', async () => {
    const { handler } = await setup({ timeoutMs: 300 });
    const { key, event } = await uploadPdf();
    stub.reply(() => ({ status: 200, body: {}, delayMs: 5_000 }));

    const started = Date.now();
    await expect(handler(event)).rejects.toThrow('DISPUTES_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await exists(quarantine, key)).toBe(true);
  });

  const problem = (code: string) => ({ type: 'about:blank', title: 'Conflict', status: 409, code, correlationId: 'c0rrelation-id' });

  it.each([
    ['EVIDENCE_CLOSED', problem('EVIDENCE_CLOSED'), 'deleted', 'CLOSED'],
    ['RESULT_CONFLICT', problem('RESULT_CONFLICT'), 'kept', 'DISPUTES_RESULT_CONFLICT'],
    ['an unknown code', problem('INVALID_TRANSITION'), 'kept', 'DISPUTES_UNKNOWN_CONFLICT'],
    ['an unparseable body', undefined, 'kept', 'DISPUTES_UNKNOWN_CONFLICT'],
  ] as const)('disputes 409 with %s: object %s', async (_name, body, fate, result) => {
    const { handler, logs } = await setup();
    const { key, evidenceId, transactionId, event } = await uploadPdf();
    stub.reply(() => ({ status: 409, ...(body ? { body } : {}) }));

    if (result === 'CLOSED') expect(await handler(event)).toEqual({ outcome: 'CLOSED' });
    else await expect(handler(event)).rejects.toThrow(result);

    expect(await exists(quarantine, key)).toBe(fate === 'kept');
    expect(await keys(evidence)).toEqual([]);
    const lines = logs().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const conflicts = lines.filter((line) => line['EvidenceResultConflict'] === 1);
    expect(conflicts).toHaveLength(result === 'DISPUTES_RESULT_CONFLICT' ? 1 : 0);
    if (result === 'DISPUTES_RESULT_CONFLICT') {
      expect(conflicts[0]?.['_aws']).toMatchObject({
        CloudWatchMetrics: [{ Namespace: 'cd/evidence-intake', Dimensions: [[]], Metrics: [{ Name: 'EvidenceResultConflict' }] }],
      });
      const error = lines.find((line) => line['level'] === 50 && String(line['msg']).includes('conflicts'));
      expect(error).toMatchObject({ evidenceId, transactionId, correlationId: event.id, claimed: 'STORED' });
    }
  });

  it('disputes 404 throws and keeps the object', async () => {
    const { handler } = await setup();
    const { key, event } = await uploadPdf();
    stub.reply(() => ({ status: 404, body: { code: 'NOT_FOUND' } }));

    await expect(handler(event)).rejects.toThrow('DISPUTES_NOT_FOUND');
    expect(await exists(quarantine, key)).toBe(true);
  });

  it('an s3Key outside evidence/{uuid}/{evidenceId} is refused: nothing copied, object kept', async () => {
    const { handler } = await setup();
    const { key, evidenceId, event } = await uploadPdf();
    stub.reply(() => ({ status: 200, body: { evidenceId, status: 'STORED', s3Key: `public/${evidenceId}` } }));

    await expect(handler(event)).rejects.toThrow('DISPUTES_BAD_RESPONSE');
    expect(await keys(evidence)).toEqual([]);
    expect(await exists(quarantine, key)).toBe(true);
  });

  it('a 401 drops the cached token and retries once with a fresh one', async () => {
    const { handler } = await setup();
    const { event } = await uploadPdf();
    stub.reply((req, call) => (call === 1 ? { status: 401, body: {} } : recordAsReported(req)));

    expect(await handler(event)).toEqual({ outcome: 'PROMOTED' });
    expect(stub.puts().map((p) => p.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});

describe('EVIDENCE_REQUIRE_SCAN', () => {
  it('default true: an S3 Object Created event throws and calls nothing', async () => {
    const { handler } = await setup();
    const { key, eTag } = await uploadPdf();

    await expect(handler(objectCreatedEvent({ bucket: quarantine, key, eTag }))).rejects.toThrow('SCAN_REQUIRED');
    expect(stub.puts()).toEqual([]);
    expect(await exists(quarantine, key)).toBe(true);
  });

  it('false: Object Created is promoted after the fact checks and emits EvidenceNotScanned (EMF) + warn', async () => {
    const { handler, logs } = await setup({ env: { EVIDENCE_REQUIRE_SCAN: 'false' } });
    const { key, eTag, evidenceId } = await uploadPdf();

    expect(await handler(objectCreatedEvent({ bucket: quarantine, key, eTag }))).toEqual({ outcome: 'PROMOTED' });

    expect(await keys(evidence)).toEqual([`evidence/${DISPUTE_ID}/${evidenceId}`]);
    const lines = logs().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const metric = lines.find((line) => line['EvidenceNotScanned'] === 1);
    expect(metric?.['_aws']).toMatchObject({
      CloudWatchMetrics: [{ Namespace: 'cd/evidence-intake', Metrics: [{ Name: 'EvidenceNotScanned', Unit: 'Count' }] }],
    });
    expect(lines.some((line) => line['level'] === 40 && String(line['msg']).includes('without a malware scan'))).toBe(true);
  });
});

describe('service client secret source', () => {
  const secretsReturning = (outcome: () => Promise<{ SecretString?: string }>) => {
    const asked: string[] = [];
    const client: SecretsClient = {
      send: async (command: GetSecretValueCommand) => {
        asked.push(command.input.SecretId ?? '');
        return { $metadata: {}, ...(await outcome()) };
      },
    };
    return { client, asked };
  };

  it('with SERVICE_CLIENT_SECRET_ID the secret comes from Secrets Manager, trimmed', async () => {
    const { client, asked } = secretsReturning(async () => ({ SecretString: '  from-secrets-manager\n' }));
    const { handler } = await setup({ secrets: client });
    const { event } = await uploadPdf();

    expect(await handler(event)).toEqual({ outcome: 'PROMOTED' });
    expect(asked).toEqual(['cd/dev/svc-evidence-intake']);
    expect(stub.tokenRequests()[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('svc-evidence-intake:from-secrets-manager').toString('base64')}`,
    );
  });

  it('a missing secret fails init and no token is requested', async () => {
    const { client } = secretsReturning(() =>
      Promise.reject(new ResourceNotFoundException({ message: 'not found', $metadata: {} })),
    );
    await expect(setup({ secrets: client })).rejects.toThrow('service client secret not_found');
    expect(stub.tokenRequests()).toEqual([]);
  });

  it('config refuses both or neither secret source', () => {
    const base = {
      AWS_REGION: 'eu-north-1',
      QUARANTINE_BUCKET: 'q',
      EVIDENCE_BUCKET: 'e',
      DISPUTES_SERVICE_URL: 'http://disputes:8081',
      TOKEN_URL: 'http://issuer/oauth2/token',
      SERVICE_CLIENT_ID: 'svc-evidence-intake',
    };
    expect(configSchema.safeParse(base).success).toBe(false);
    expect(configSchema.safeParse({ ...base, SERVICE_CLIENT_SECRET: 'a', SERVICE_CLIENT_SECRET_ID: 'b' }).success).toBe(false);
    expect(configSchema.parse({ ...base, SERVICE_CLIENT_SECRET: 'a' }).EVIDENCE_REQUIRE_SCAN).toBe(true);
  });
});

