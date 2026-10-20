import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

const run = promisify(execFile);

export const S3_REGION = 'af-south-1';
export const S3_KEY = { accessKeyId: 'test', secretAccessKey: 'test-secret-key' } as const;
const MOTO_IMAGE = 'motoserver/moto:5.2.4';

export type Moto = { readonly endpoint: string; readonly stop: () => Promise<void> };

const waitForMoto = async (endpoint: string, deadline: number): Promise<void> => {
  const up = await fetch(`${endpoint}/moto-api/`).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  if (Date.now() > deadline) throw new Error(`moto did not become ready at ${endpoint}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return waitForMoto(endpoint, deadline);
};

// MOTO_ENDPOINT reuses the compose `moto` service (host port 55000); otherwise a throwaway container is started.
export const startMoto = async (): Promise<Moto> => {
  const shared = process.env.MOTO_ENDPOINT;
  if (shared) {
    await waitForMoto(shared, Date.now() + 30_000);
    return { endpoint: shared, stop: async () => undefined };
  }
  const name = `cd-disputes-test-moto-${randomUUID().slice(0, 8)}`;
  await run('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const { stdout } = await run('docker', ['port', name, '5000/tcp']);
  const hostPort = stdout.trim().split('\n')[0]?.split(':').pop();
  const endpoint = `http://127.0.0.1:${hostPort}`;
  await waitForMoto(endpoint, Date.now() + 60_000);
  return {
    endpoint,
    stop: async () => {
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    },
  };
};

export const s3ClientFor = (endpoint: string): S3Client =>
  new S3Client({ region: S3_REGION, endpoint, forcePathStyle: true, credentials: S3_KEY });

// Idempotent because test files share the compose moto when MOTO_ENDPOINT is set.
export const createBucket = async (endpoint: string, bucket: string): Promise<void> => {
  await s3ClientFor(endpoint)
    .send(
      new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: S3_REGION } }),
    )
    .catch((e: unknown) => {
      if ((e as { name?: unknown }).name !== 'BucketAlreadyOwnedByYou') throw e;
    });
};

export const headObject = (endpoint: string, bucket: string, key: string) =>
  s3ClientFor(endpoint).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

type Verdict = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly code: string };

// SigV4 query-auth check as S3 performs it (docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html).
const verifyPresigned = (
  method: string,
  rawUrl: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Verdict => {
  const url = new URL(rawUrl, 'http://placeholder');
  const q = url.searchParams;
  const signature = q.get('X-Amz-Signature') ?? '';
  const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
  const [, date, region, service] = (q.get('X-Amz-Credential') ?? '').split('/');
  const amzDate = q.get('X-Amz-Date') ?? '';
  const canonicalQuery = [...q.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h] ?? '').trim()}\n`).join('');
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${S3_KEY.secretAccessKey}`, date ?? ''), region ?? ''), service ?? ''),
    'aws4_request',
  );
  const expected = Buffer.from(hmac(key, stringToSign).toString('hex'));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, status: 403, code: 'SignatureDoesNotMatch' };
  }
  const checksum = headers['x-amz-checksum-sha256'];
  if (checksum !== createHash('sha256').update(body).digest('base64')) {
    return { ok: false, status: 400, code: 'BadDigest' };
  }
  return { ok: true };
};

export type S3Front = { readonly endpoint: string; readonly stop: () => Promise<void> };

// moto accepts any presigned PUT (it checks neither signature nor checksum), so this front enforces both, then stores in moto.
export const startVerifyingS3Front = async (motoEndpoint: string): Promise<S3Front> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const verdict = verifyPresigned(req.method ?? '', req.url ?? '', req.headers, body);
      if (!verdict.ok) {
        res.writeHead(verdict.status, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>${verdict.code}</Code></Error>`);
        return;
      }
      void fetch(`${motoEndpoint}${req.url ?? ''}`, {
        method: req.method ?? 'PUT',
        headers: {
          'content-type': String(req.headers['content-type']),
          'x-amz-checksum-sha256': String(req.headers['x-amz-checksum-sha256']),
        },
        body,
      }).then(
        async (upstream) => {
          res.writeHead(upstream.status);
          res.end(await upstream.text());
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

// Written out independently of src so a wrong key in the signer fails the test (ADR-055).
export const quarantineKey = (transactionId: string, evidenceId: string): string =>
  `intake/${transactionId}/${evidenceId}`;
