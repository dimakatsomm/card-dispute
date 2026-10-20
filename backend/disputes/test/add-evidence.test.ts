import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectContract } from './helpers/contract.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import { createFakeUpstreams, USER_A, USER_B, type FakeUpstreams } from './helpers/fakes.ts';
import {
  createBucket,
  headObject,
  quarantineKey,
  S3_KEY,
  startMoto,
  startVerifyingS3Front,
  type Moto,
  type S3Front,
} from './helpers/s3.ts';
import { seedDispute, seedEvidence, type SeededDispute } from './helpers/seed.ts';
import {
  poolPausingAfter,
  QUARANTINE_BUCKET,
  startTestService,
  type TestService,
} from './helpers/service.ts';

type Upload = {
  readonly evidenceId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
};

type SeedStatus = Parameters<typeof seedEvidence>[2]['status'];

const fileOf = (label: string): Buffer => Buffer.from(`%PDF-1.7\n${label}\n`);
const hexOf = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const declaration = (label: string, overrides: Record<string, unknown> = {}) => ({
  fileName: `${label}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: fileOf(label).length,
  sha256: hexOf(fileOf(label)),
  ...overrides,
});

const distinct = (n: number) => Array.from({ length: n }, () => declaration(randomUUID()));

let db: TestDb;
let moto: Moto;
let front: S3Front;
let upstreams: FakeUpstreams;
let svc: TestService;

const postEvidence = (service: TestService, token: string, transactionId: string, evidence: unknown) =>
  service.servers.public.inject({
    method: 'POST',
    url: `/dispute/${transactionId}/evidence`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ evidence }),
  });

const uploadsOf = (res: { json: () => unknown }): ReadonlyArray<Upload> =>
  (res.json() as { uploads: ReadonlyArray<Upload> }).uploads;

const seedOpen = async (
  status: 'SUBMITTED' | 'UNDER_REVIEW' = 'SUBMITTED',
): Promise<{ readonly transactionId: string; readonly seeded: SeededDispute }> => {
  const transactionId = randomUUID();
  return { transactionId, seeded: await seedDispute(db, { userId: USER_A.userId, transactionId, status }) };
};

const evidenceCount = (transactionId: string) => db.count('dispute_evidence', transactionId);

const disputeState = async (transactionId: string) =>
  (
    await db.appQuery('select version, updated_at, updated_by from dispute where transaction_id = $1', [
      transactionId,
    ])
  ).rows[0] as { version: number; updated_at: Date; updated_by: string };

beforeAll(async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', S3_KEY.accessKeyId);
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', S3_KEY.secretAccessKey);
  [db, moto] = await Promise.all([startDisputesDb(), startMoto()]);
  await createBucket(moto.endpoint, QUARANTINE_BUCKET);
  front = await startVerifyingS3Front(moto.endpoint);
  upstreams = createFakeUpstreams();
  svc = await startTestService({ pool: db.appPool, upstreams, s3Endpoint: front.endpoint });
});

afterAll(async () => {
  await svc?.servers.close();
  await front?.stop();
  await moto?.stop();
  await db?.stop();
  vi.unstubAllEnvs();
});

describe('POST /dispute/{transactionId}/evidence', () => {
  it('declares new files → 201 PENDING slots at intake/{transactionId}/{evidenceId}; the signed PUT lands on moto', async () => {
    const { transactionId } = await seedOpen();
    const res = await postEvidence(svc, USER_A.token, transactionId, [
      declaration('statement'),
      declaration('photo'),
    ]);

    expect(res.statusCode).toBe(201);
    expectContract('addEvidence', res.json());
    const uploads = uploadsOf(res);
    expect(uploads).toHaveLength(2);
    const rows = await db.appQuery(
      `select e.evidence_id::text as evidence_id, e.file_name, e.status from dispute_evidence e
       join dispute d on d.id = e.dispute_id where d.transaction_id = $1 order by e.id`,
      [transactionId],
    );
    expect(rows.rows).toEqual(
      uploads.map((u, i) => ({
        evidence_id: u.evidenceId,
        file_name: ['statement.pdf', 'photo.pdf'][i],
        status: 'PENDING',
      })),
    );

    const [first] = uploads;
    if (first === undefined) throw new Error('no upload');
    expect(new URL(first.url).pathname).toBe(`/${QUARANTINE_BUCKET}/${quarantineKey(transactionId, first.evidenceId)}`);
    const put = await fetch(first.url, { method: 'PUT', headers: first.headers, body: fileOf('statement') });
    expect(put.status).toBe(200);
    const head = await headObject(moto.endpoint, QUARANTINE_BUCKET, quarantineKey(transactionId, first.evidenceId));
    expect(head.ContentLength).toBe(fileOf('statement').length);
  });

  it('writes no history row, leaves version, updated_at and updated_by alone and publishes nothing', async () => {
    const { transactionId } = await seedOpen();
    const before = await disputeState(transactionId);
    const sent = svc.messages.length;

    const res = await postEvidence(svc, USER_A.token, transactionId, distinct(2));

    expect(res.statusCode).toBe(201);
    expect(await disputeState(transactionId)).toEqual(before);
    expect(await db.count('dispute_status_history', transactionId)).toBe(0);
    expect(svc.messages.slice(sent)).toEqual([]);
  });

  it('is allowed while UNDER_REVIEW', async () => {
    const { transactionId } = await seedOpen('UNDER_REVIEW');
    const res = await postEvidence(svc, USER_A.token, transactionId, distinct(1));
    expect(res.statusCode).toBe(201);
    expect(await evidenceCount(transactionId)).toBe(1);
  });

  it("user B on user A's dispute → 404 and no rows", async () => {
    const { transactionId } = await seedOpen();
    const res = await postEvidence(svc, USER_B.token, transactionId, distinct(1));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(await evidenceCount(transactionId)).toBe(0);
  });

  it('a transaction with no dispute → 404', async () => {
    const res = await postEvidence(svc, USER_A.token, randomUUID(), distinct(1));
    expect(res.statusCode).toBe(404);
  });

  it.each(['WITHDRAWN', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED'] as const)(
    '%s dispute → 409 INVALID_TRANSITION and no rows',
    async (status) => {
      const transactionId = randomUUID();
      await seedDispute(db, { userId: USER_A.userId, transactionId, status });
      const res = await postEvidence(svc, USER_A.token, transactionId, distinct(1));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
      expect(await evidenceCount(transactionId)).toBe(0);
    },
  );

  it('a body over the dispute body limit → 413 HTTP_413 (not TOO_MANY_FILES), no rows', async () => {
    const { transactionId } = await seedOpen();
    const res = await postEvidence(svc, USER_A.token, transactionId, [
      declaration('big', { fileName: 'x'.repeat(64 * 1024) }),
    ]);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'HTTP_413' });
    expect(await evidenceCount(transactionId)).toBe(0);
  });
});

describe('5-file cap (PENDING + STORED + new)', () => {
  const seedMany = async (seeded: SeededDispute, statuses: ReadonlyArray<SeedStatus>) => {
    for (const [i, status] of statuses.entries()) {
      await seedEvidence(db, seeded, { fileName: `old-${i}.pdf`, status, sha256: hexOf(randomUUID()) });
    }
  };

  it.each([
    { existing: ['PENDING', 'PENDING', 'STORED', 'STORED'], added: 1, status: 201 },
    { existing: ['PENDING', 'PENDING', 'STORED', 'STORED'], added: 2, status: 413 },
    { existing: ['PENDING', 'PENDING', 'PENDING', 'STORED', 'STORED'], added: 1, status: 413 },
    { existing: ['REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED'], added: 5, status: 201 },
    { existing: ['EXPIRED', 'EXPIRED', 'EXPIRED', 'EXPIRED', 'EXPIRED'], added: 5, status: 201 },
    { existing: ['ERASED', 'ERASED', 'ERASED', 'ERASED', 'ERASED'], added: 5, status: 201 },
    { existing: ['STORED', 'REJECTED', 'EXPIRED', 'ERASED'], added: 4, status: 201 },
    { existing: ['STORED', 'REJECTED', 'EXPIRED', 'ERASED'], added: 5, status: 413 },
  ] as const)('$existing + $added new → $status', async ({ existing, added, status }) => {
    const { transactionId, seeded } = await seedOpen();
    await seedMany(seeded, existing);

    const res = await postEvidence(svc, USER_A.token, transactionId, distinct(added));

    expect(res.statusCode).toBe(status);
    expect(await evidenceCount(transactionId)).toBe(existing.length + (status === 201 ? added : 0));
    if (status === 413) expect(res.json()).toMatchObject({ code: 'TOO_MANY_FILES' });
  });

  it('two concurrent 3-file requests on an empty dispute → exactly one 201 and one 413', async () => {
    const overlapping = await startTestService({
      pool: poolPausingAfter(db.appPool, 'from dispute_evidence where dispute_id', 300),
      upstreams,
      s3Endpoint: front.endpoint,
    });
    try {
      const { transactionId } = await seedOpen();
      const results = await Promise.all([
        postEvidence(overlapping, USER_A.token, transactionId, distinct(3)),
        postEvidence(overlapping, USER_A.token, transactionId, distinct(3)),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 413]);
      expect(results.find((r) => r.statusCode === 413)?.json()).toMatchObject({ code: 'TOO_MANY_FILES' });
      expect(await evidenceCount(transactionId)).toBe(3);
    } finally {
      await overlapping.servers.close();
    }
  });
});

describe('retry-safe re-signing (ADR-050)', () => {
  const PENDING_FILE = declaration('receipt');

  const seedPending = async (seeded: SeededDispute, status: SeedStatus = 'PENDING') =>
    seedEvidence(db, seeded, {
      fileName: PENDING_FILE.fileName,
      status,
      sha256: PENDING_FILE.sha256,
      sizeBytes: PENDING_FILE.sizeBytes,
    });

  it('an equal declaration to a PENDING item → same evidenceId, no new row, a freshly signed URL', async () => {
    const clock = { ms: Date.now() };
    const ticking = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      now: () => new Date(clock.ms),
    });
    try {
      const { transactionId, seeded } = await seedOpen();
      const evidenceId = await seedPending(seeded);

      const first = await postEvidence(ticking, USER_A.token, transactionId, [PENDING_FILE]);
      clock.ms += 60_000;
      const second = await postEvidence(ticking, USER_A.token, transactionId, [PENDING_FILE]);

      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      const [a, b] = [uploadsOf(first)[0], uploadsOf(second)[0]];
      expect([a?.evidenceId, b?.evidenceId]).toEqual([evidenceId, evidenceId]);
      expect(b?.url).not.toBe(a?.url);
      expect(Date.parse(b?.expiresAt ?? '') - Date.parse(a?.expiresAt ?? '')).toBe(60_000);
      expect(await evidenceCount(transactionId)).toBe(1);
    } finally {
      await ticking.servers.close();
    }
  });

  it('a different fileName with the same sha256, size and type re-signs the PENDING item', async () => {
    const { transactionId, seeded } = await seedOpen();
    const evidenceId = await seedPending(seeded);
    const res = await postEvidence(svc, USER_A.token, transactionId, [
      { ...PENDING_FILE, fileName: 'renamed.pdf' },
    ]);
    expect(res.statusCode).toBe(201);
    expect(uploadsOf(res).map((u) => u.evidenceId)).toEqual([evidenceId]);
    expect(await evidenceCount(transactionId)).toBe(1);
  });

  it.each([
    { name: 'sha256', change: { sha256: hexOf('other bytes') } },
    { name: 'sizeBytes', change: { sizeBytes: PENDING_FILE.sizeBytes + 1 } },
    { name: 'contentType', change: { contentType: 'image/png' } },
  ])('a declaration differing in $name gets a new slot', async ({ change }) => {
    const { transactionId, seeded } = await seedOpen();
    const evidenceId = await seedPending(seeded);
    const res = await postEvidence(svc, USER_A.token, transactionId, [{ ...PENDING_FILE, ...change }]);
    expect(res.statusCode).toBe(201);
    expect(uploadsOf(res)[0]?.evidenceId).not.toBe(evidenceId);
    expect(await evidenceCount(transactionId)).toBe(2);
  });

  it.each(['STORED', 'REJECTED', 'EXPIRED'] as const)(
    'an equal declaration to a %s item gets a new slot',
    async (status) => {
      const { transactionId, seeded } = await seedOpen();
      const evidenceId = await seedPending(seeded, status);
      const res = await postEvidence(svc, USER_A.token, transactionId, [PENDING_FILE]);
      expect(res.statusCode).toBe(201);
      expect(uploadsOf(res)[0]?.evidenceId).not.toBe(evidenceId);
      expect(await evidenceCount(transactionId)).toBe(2);
    },
  );

  it('each PENDING row is matched at most once per request', async () => {
    const { transactionId, seeded } = await seedOpen();
    const evidenceId = await seedPending(seeded);
    const res = await postEvidence(svc, USER_A.token, transactionId, [PENDING_FILE, PENDING_FILE]);
    expect(res.statusCode).toBe(201);
    const [reused, fresh] = uploadsOf(res).map((u) => u.evidenceId);
    expect(reused).toBe(evidenceId);
    expect(fresh).not.toBe(evidenceId);
    expect(await evidenceCount(transactionId)).toBe(2);
  });

  it('re-signed items do not count again toward the cap', async () => {
    const { transactionId, seeded } = await seedOpen();
    await seedPending(seeded);
    for (const status of ['STORED', 'STORED', 'PENDING', 'PENDING'] as const) {
      await seedEvidence(db, seeded, { fileName: 'other.pdf', status, sha256: hexOf(randomUUID()) });
    }
    const res = await postEvidence(svc, USER_A.token, transactionId, [PENDING_FILE]);
    expect(res.statusCode).toBe(201);
    expect(await evidenceCount(transactionId)).toBe(5);
  });

  it('signing failure → 503 UPLOAD_SIGNING_UNAVAILABLE with the slots committed; a repeat re-signs the same slots', async () => {
    const unsignable = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      presign: async () => {
        throw new Error('credentials unavailable');
      },
    });
    try {
      const { transactionId } = await seedOpen();
      const files = distinct(2);
      const failed = await postEvidence(unsignable, USER_A.token, transactionId, files);
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ code: 'UPLOAD_SIGNING_UNAVAILABLE' });
      const committed = await db.appQuery(
        `select e.evidence_id::text as evidence_id from dispute_evidence e
         join dispute d on d.id = e.dispute_id where d.transaction_id = $1 order by e.id`,
        [transactionId],
      );
      expect(committed.rows).toHaveLength(2);

      const retried = await postEvidence(svc, USER_A.token, transactionId, files);
      expect(retried.statusCode).toBe(201);
      expect(uploadsOf(retried).map((u) => u.evidenceId)).toEqual(
        committed.rows.map((r) => (r as { evidence_id: string }).evidence_id),
      );
      expect(await evidenceCount(transactionId)).toBe(2);
    } finally {
      await unsignable.servers.close();
    }
  });
});

it('evidence types, caps and TTL come from @cd/dispute-domain (no local literals in src)', async () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
  const offenders = (
    await Promise.all(
      files.map(async (f) =>
        /application\/pdf|10_?485_?760/.test(await readFile(join(srcDir, f), 'utf8')) ? [f] : [],
      ),
    )
  ).flat();
  expect(offenders).toEqual([]);
});
