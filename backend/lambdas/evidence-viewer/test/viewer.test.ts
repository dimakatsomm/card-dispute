import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config.ts';
import { createHandler } from '../src/handler.ts';
import { createS3Client } from '../src/main.ts';
import { mintEvidenceUrl } from '../src/use-cases/mint-evidence-url.ts';
import { BUCKET, DISPUTE_ID, EVIDENCE_ID, NOW, capturedLog, validRequest, viewer } from './support/harness.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('request validation', () => {
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['a non-UUID disputeId', { ...validRequest, disputeId: 'not-a-uuid' }],
    ['a path-like evidenceId', { ...validRequest, evidenceId: '../../quarantine/9a8b7c6d' }],
    ['a key-shaped disputeId', { ...validRequest, disputeId: `evidence/${DISPUTE_ID}` }],
    ['an extra s3Key', { ...validRequest, s3Key: 'evidence/other/object' }],
    ['an extra bucket', { ...validRequest, bucket: 'someone-elses-bucket' }],
    ['a caller-supplied file name', { ...validRequest, fileName: 'statement.pdf' }],
    ['an unsupported content type', { ...validRequest, contentType: 'text/html' }],
    ['a correlationId with header-breaking characters', { ...validRequest, correlationId: 'abc\r\ndef-ghij' }],
    ['a missing correlationId', { disputeId: DISPUTE_ID, evidenceId: EVIDENCE_ID, contentType: 'image/png' }],
    ['a non-object payload', 'evidence/x/y'],
  ];

  it.each(invalid)('throws on %s without signing or logging values', async (_, event) => {
    const { log, text } = capturedLog();
    const presign = vi.fn(() => Promise.resolve('https://unused.example'));
    const handler = createHandler(mintEvidenceUrl({ presign, now: () => NOW, allowPlainHttp: false, log }), log);

    await expect(handler(event)).rejects.toThrow('evidence url refused: invalid_request');

    expect(presign).not.toHaveBeenCalled();
    expect(text()).toContain('"kind":"invalid_request"');
    for (const value of ['not-a-uuid', '../', 'evidence/', 'someone-elses', 'statement.pdf', 'text/html', 'abc'])
      expect(text()).not.toContain(value);
  });
});

describe('minted URL', () => {
  it('reports the expiry the signature enforces when the clock has milliseconds', async () => {
    const { handler } = viewer({}, { now: () => new Date('2026-11-05T10:00:00.750Z') });

    const { url, expiresAt } = await handler(validRequest);

    expect(new URL(url).searchParams.get('X-Amz-Date')).toBe('20261105T100000Z');
    expect(expiresAt).toBe('2026-11-05T10:01:00.000Z');
  });

  it('presigns GetObject on the derived key for 60 s with generated attachment headers', async () => {
    const { handler } = viewer();

    const { url, expiresAt } = await handler(validRequest);

    const parsed = new URL(url);
    const q = parsed.searchParams;
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe(`${BUCKET}.s3.eu-north-1.amazonaws.com`);
    expect(parsed.pathname).toBe(`/evidence/${DISPUTE_ID}/${EVIDENCE_ID}`);
    expect(q.get('X-Amz-Date')).toBe('20261105T100000Z');
    expect(q.get('X-Amz-Expires')).toBe('60');
    expect(expiresAt).toBe('2026-11-05T10:01:00.000Z');
    // Anything beyond host would have to be sent by the browser, which it never does.
    expect(q.get('X-Amz-SignedHeaders')).toBe('host');
    expect(q.get('response-content-disposition')).toBe(`attachment; filename="${EVIDENCE_ID}.pdf"`);
    expect(q.get('response-content-type')).toBe('application/pdf');
    expect(q.get('response-cache-control')).toBe('no-store');
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
  ])('names a %s download <evidenceId>.%s', async (contentType, ext) => {
    const { handler } = viewer();

    const { url } = await handler({ ...validRequest, contentType });

    const q = new URL(url).searchParams;
    expect(q.get('response-content-disposition')).toBe(`attachment; filename="${EVIDENCE_ID}.${ext}"`);
    expect(q.get('response-content-type')).toBe(contentType);
  });
});

describe('https rule', () => {
  it('keeps the real S3 endpoint even when the SDK endpoint env vars point elsewhere', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://attacker.example:9000');
    const config = configSchema.parse({ AWS_REGION: 'eu-north-1', EVIDENCE_BUCKET: BUCKET });
    const { handler } = viewer({}, { s3: createS3Client(config) });

    const { url } = await handler(validRequest);

    expect(new URL(url).origin).toBe(`https://${BUCKET}.s3.eu-north-1.amazonaws.com`);
  });

  it('refuses a plain-http URL when no local endpoint is configured, without logging it', async () => {
    const { log, text } = capturedLog();
    const httpUrl = 'http://cd-dev-evidence.s3.eu-north-1.amazonaws.com/evidence/x?X-Amz-Signature=deadbeef';
    const handler = createHandler(
      mintEvidenceUrl({ presign: () => Promise.resolve(httpUrl), now: () => NOW, allowPlainHttp: false, log }),
      log,
    );

    await expect(handler(validRequest)).rejects.toThrow('evidence url refused: insecure_url');
    expect(text()).not.toContain('deadbeef');
  });

  it('allows plain http only with an explicit local endpoint', async () => {
    const { handler } = viewer({ AWS_ENDPOINT_URL: 'http://127.0.0.1:5000' });

    const { url } = await handler(validRequest);

    expect(url.startsWith(`http://127.0.0.1:5000/${BUCKET}/evidence/${DISPUTE_ID}/${EVIDENCE_ID}?`)).toBe(true);
  });
});

describe('logging', () => {
  it('logs one "evidence url minted" line with ids only, never the URL or signature', async () => {
    const { handler, text, entries } = viewer();

    const { url } = await handler(validRequest);

    const signature = new URL(url).searchParams.get('X-Amz-Signature') ?? '';
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      msg: 'evidence url minted',
      disputeId: DISPUTE_ID,
      evidenceId: EVIDENCE_ID,
      correlationId: validRequest.correlationId,
    });
    expect(Object.keys(entries()[0] ?? {}).sort()).toEqual(
      ['correlationId', 'disputeId', 'evidenceId', 'hostname', 'level', 'msg', 'pid', 'time'].sort(),
    );
    expect(text()).not.toContain(signature);
    expect(text()).not.toContain('amazonaws.com');
  });
});
