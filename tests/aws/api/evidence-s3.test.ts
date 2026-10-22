import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { tokenFor } from '../src/auth.ts';
import { errorName, httpStatus, s3 } from '../src/aws.ts';
import { env } from '../src/env.ts';
import { cleanPdf, declare, eicar, renamedExe, sha256Base64, type Declared } from '../src/files.ts';
import { api, claimDisputable, type Json, type Txn } from '../src/http.ts';
import { until } from '../src/poll.ts';
import { asHttp, rawRequest } from '../src/raw.ts';

const SCAN_WAIT_MS = 8 * 60_000;

const s3Code = (body: string): string | undefined => /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
const s3Fault = (body: string): string =>
  `${s3Code(body) ?? 'none'}: ${/<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? ''}`;
const escapeDots = (value: string): string => value.replaceAll('.', '\\.');

const bucketUrl = (key: string): string =>
  `https://${env().quarantineBucket}.s3.${env().region}.amazonaws.com/${key}`;

describe('quarantine bucket CORS', () => {
  const preflight = (origin: string) =>
    rawRequest('OPTIONS', bucketUrl('intake/cors-probe'), {
      origin,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type,x-amz-checksum-sha256',
    });

  it('refuses a preflight from another origin', async () => {
    const reply = await preflight('https://evil.example.com');
    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from the web origin with exactly that origin', async () => {
    const reply = await preflight(env().webOrigin);
    expect(reply.status).toBe(200);
    expect(reply.headers['access-control-allow-origin']).toBe(env().webOrigin);
    expect(reply.headers['access-control-allow-methods']).toContain('PUT');
  });
});

describe('evidence upload against real S3 (consumes 1 transaction)', () => {
  const pdf: Declared = { fileName: 'receipt-e2e-aws.pdf', bytes: cleanPdf() };
  const virus: Declared = { fileName: 'eicar-e2e-aws.pdf', bytes: eicar() };
  const exe: Declared = { fileName: 'renamed-e2e-aws.pdf', bytes: renamedExe() };
  let tokenA: string;
  let target: Txn;
  let disputeId: string;
  let uploads: readonly Json[];
  let ids: { readonly pdf: string; readonly virus: string; readonly exe: string };
  let final: Json;

  const upload = (file: Declared): Json => {
    const found = uploads.find(
      (candidate) => candidate['headers']['x-amz-checksum-sha256'] === sha256Base64(file.bytes),
    );
    if (found === undefined) throw new Error(`no presigned upload matches the checksum of ${file.fileName}`);
    return found;
  };
  const headersOf = (instruction: Json): Record<string, string> => ({ ...instruction['headers'] });
  const quarantineKey = (file: Declared): string =>
    `intake/${target.transactionId}/${upload(file)['evidenceId']}`;

  beforeAll(async () => {
    tokenA = await tokenFor('A');
  });

  it('POST /dispute with three declared files returns one presigned PUT per file bound to its checksum', async () => {
    target = await claimDisputable(tokenA);
    const reply = await api('POST', `/dispute/${target.transactionId}`, {
      token: tokenA,
      body: {
        reasonCode: 'NOT_RECEIVED',
        description: `e2e-aws evidence flow ${new Date().toISOString()}`,
        evidence: [declare(pdf), declare(virus), declare(exe)],
      },
    });
    expect(reply.status).toBe(201);
    disputeId = reply.body['disputeId'];
    uploads = reply.body['uploads'];
    expect(uploads).toHaveLength(3);
    ids = {
      pdf: upload(pdf)['evidenceId'],
      virus: upload(virus)['evidenceId'],
      exe: upload(exe)['evidenceId'],
    };
    for (const instruction of uploads) {
      const expectedUrl = new RegExp(
        `^https://${escapeDots(env().quarantineBucket)}\\.s3\\.${escapeDots(env().region)}\\.amazonaws\\.com/`,
      );
      expect(
        expectedUrl.test(String(instruction['url'])),
        'presigned URL targets the quarantine bucket over https',
      ).toBe(true);
      expect(Object.keys(instruction['headers']).sort()).toEqual([
        'Content-Length',
        'Content-Type',
        'x-amz-checksum-sha256',
      ]);
    }
  });

  describe('V-08: S3 rejects every deviation from the signed request (nothing is stored)', () => {
    const put = (headers: Record<string, string>, body: Uint8Array, url = upload(pdf)['url'] as string) =>
      rawRequest('PUT', url, headers, body);

    it('a tampered body with the signed length and checksum header is rejected', async () => {
      const tampered = Uint8Array.from(pdf.bytes);
      tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0xff;
      const reply = await put(headersOf(upload(pdf)), tampered);
      expect(['BadDigest', 'XAmzContentSHA256Mismatch'], s3Fault(reply.body)).toContain(s3Code(reply.body));
      expect(reply.status).toBe(400);
    });

    it('a different Content-Type is rejected', async () => {
      const reply = await put({ ...headersOf(upload(pdf)), 'Content-Type': 'image/png' }, pdf.bytes);
      expect(s3Code(reply.body), s3Fault(reply.body)).toBe('SignatureDoesNotMatch');
      expect(reply.status).toBe(403);
    });

    it('a request with the checksum header stripped is rejected', async () => {
      const headers = Object.fromEntries(
        Object.entries(headersOf(upload(pdf))).filter(([name]) => name !== 'x-amz-checksum-sha256'),
      );
      const reply = await put(headers, pdf.bytes);
      expect(s3Code(reply.body), s3Fault(reply.body)).toBe('SignatureDoesNotMatch');
      expect(reply.status).toBe(403);
    });

    it('a body whose length differs from the signed Content-Length is rejected', async () => {
      const longer = Uint8Array.from([...pdf.bytes, ...new TextEncoder().encode('padding')]);
      const reply = await put({ ...headersOf(upload(pdf)), 'Content-Length': String(longer.length) }, longer);
      expect(s3Code(reply.body), s3Fault(reply.body)).toBe('SignatureDoesNotMatch');
      expect(reply.status).toBe(403);
    });

    it('the exact signed request over plain HTTP is denied by the bucket policy', async () => {
      const reply = await put(headersOf(upload(pdf)), pdf.bytes, asHttp(upload(pdf)['url']));
      expect(s3Code(reply.body), s3Fault(reply.body)).toBe('AccessDenied');
      expect(reply.status).toBe(403);
    });
  });

  it('the exact returned headers upload all three files over TLS and S3 encrypts them with KMS', async () => {
    for (const file of [pdf, virus, exe]) {
      const reply = await rawRequest('PUT', upload(file)['url'], headersOf(upload(file)), file.bytes);
      expect(reply.status, `${file.fileName}: ${s3Fault(reply.body)}`).toBe(200);
      expect(reply.headers['x-amz-server-side-encryption']).toBe('aws:kms');
    }
  });

  // Proves the role has no quarantine read; the bucket-policy tag deny is not isolated by this test.
  it('the e2e role cannot read quarantine objects', async () => {
    for (const file of [pdf, virus]) {
      const read = s3().send(
        new GetObjectCommand({ Bucket: env().quarantineBucket, Key: quarantineKey(file) }),
      );
      await expect(read, file.fileName).rejects.toSatisfy(
        (error: unknown) =>
          httpStatus(error) === 403 &&
          ((error as { Code?: string }).Code ?? errorName(error)) === 'AccessDenied',
      );
    }
  });

  it(
    'within a bounded wait the scan settles every file: clean PDF STORED, EICAR and renamed exe REJECTED',
    async () => {
      final = await until(
        'all evidence to leave PENDING',
        async () => {
          const reply = await api('GET', `/dispute/${target.transactionId}`, { token: await tokenFor('A') });
          return reply.status === 200 &&
            reply.body['evidence'].every((item: Json) => item['status'] !== 'PENDING')
            ? reply.body
            : undefined;
        },
        SCAN_WAIT_MS,
        10_000,
      );
      const status = (id: string): string =>
        final['evidence'].find((item: Json) => item['evidenceId'] === id)['status'];
      expect(status(ids.pdf)).toBe('STORED');
      expect(status(ids.virus)).toBe('REJECTED');
      expect(status(ids.exe)).toBe('REJECTED');
    },
    SCAN_WAIT_MS + 60_000,
  );

  it('the timeline records EVIDENCE_ADDED for the PDF, MALWARE for EICAR and TYPE_MISMATCH for the renamed exe', () => {
    const added = final['timeline'].find((event: Json) => event['type'] === 'EVIDENCE_ADDED');
    expect(added).toMatchObject({ detail: { fileName: pdf.fileName } });
    const rejected = final['timeline']
      .filter((event: Json) => event['type'] === 'EVIDENCE_REJECTED')
      .map((event: Json) => event['detail']);
    expect(rejected).toEqual(
      expect.arrayContaining([
        { fileName: virus.fileName, reason: 'MALWARE' },
        { fileName: exe.fileName, reason: 'TYPE_MISMATCH' },
      ]),
    );
  });

  it('only the clean PDF was promoted, and the promoted object is encrypted with an SSE-KMS key', async () => {
    const head = await s3().send(
      new HeadObjectCommand({ Bucket: env().evidenceBucket, Key: `evidence/${disputeId}/${ids.pdf}` }),
    );
    expect(head.ServerSideEncryption).toBe('aws:kms');
    expect(head.SSEKMSKeyId).toBeTypeOf('string');
    expect(head.ContentLength).toBe(pdf.bytes.length);
    for (const id of [ids.virus, ids.exe]) {
      const absent = s3().send(
        new HeadObjectCommand({ Bucket: env().evidenceBucket, Key: `evidence/${disputeId}/${id}` }),
      );
      await expect(absent).rejects.toSatisfy((error: unknown) => httpStatus(error) === 404);
    }
  });
});
