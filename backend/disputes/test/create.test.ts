import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisputeRepo, TRANSACTION_UNIQUE } from '../src/adapters/dispute-repo.ts';
import { startDisputesDb, type TestDb } from './helpers/db.ts';
import {
  createFakeUpstreams,
  daysAgo,
  hang,
  json,
  SERVICE_CALLER,
  URLS,
  USER_A,
  USER_B,
  type FakeUpstreams,
} from './helpers/fakes.ts';
import {
  createBucket,
  headObject,
  S3_KEY,
  startMoto,
  startVerifyingS3Front,
  type Moto,
  type S3Front,
} from './helpers/s3.ts';
import {
  poolFailingOn,
  QUARANTINE_BUCKET,
  QUEUE_URL,
  startTestService,
  type TestService,
} from './helpers/service.ts';

const FILE = Buffer.from('%PDF-1.7\nreceipt for disputed purchase\n');
const FILE_SHA_HEX = createHash('sha256').update(FILE).digest('hex');
const DESCRIPTION = 'I did not make this purchase; my card was with me.';

const declaration = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'receipt.pdf',
  contentType: 'application/pdf',
  sizeBytes: FILE.length,
  sha256: FILE_SHA_HEX,
  ...overrides,
});

type Upload = {
  readonly evidenceId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
};

let db: TestDb;
let moto: Moto;
let front: S3Front;
let upstreams: FakeUpstreams;
let svc: TestService;

const post = (service: TestService, token: string, transactionId: string, payload: unknown) =>
  service.servers.public.inject({
    method: 'POST',
    url: `/dispute/${transactionId}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

const rowCounts = async (transactionId: string) => ({
  dispute: await db.count('dispute', transactionId),
  history: await db.count('dispute_status_history', transactionId),
  evidence: await db.count('dispute_evidence', transactionId),
});

const NO_ROWS = { dispute: 0, history: 0, evidence: 0 };

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

describe('POST /dispute/{transactionId}', () => {
  it('creates a SUBMITTED dispute with history, PENDING evidence, upload URLs, ETag and a DisputeCreated event', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const before = Date.now();
    const res = await post(svc, USER_A.token, txn.transactionId, {
      reasonCode: 'FRAUD',
      description: DESCRIPTION,
      evidence: [declaration()],
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    expect(res.headers.location).toBe(`/dispute/${txn.transactionId}`);
    const body = res.json();
    expect(body).toMatchObject({
      transactionId: txn.transactionId,
      status: 'SUBMITTED',
      reasonCode: 'FRAUD',
      description: DESCRIPTION,
      version: 1,
      resolvedAt: null,
      resolutionNote: null,
      transaction: { amount: '125.50', currency: 'ZAR', cardId: txn.cardId, accountId: txn.accountId },
      evidence: [
        {
          fileName: 'receipt.pdf',
          contentType: 'application/pdf',
          sizeBytes: FILE.length,
          status: 'PENDING',
        },
      ],
    });
    const [upload] = body.uploads as Upload[];
    expect(upload?.evidenceId).toBe(body.evidence[0].evidenceId);
    expect(upload?.headers).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Length': String(FILE.length),
      'x-amz-checksum-sha256': createHash('sha256').update(FILE).digest('base64'),
    });
    const expiresIn = Date.parse(upload?.expiresAt ?? '') - before;
    expect(expiresIn).toBeGreaterThanOrEqual(600_000 - 5_000);
    expect(expiresIn).toBeLessThanOrEqual(600_000 + 5_000);

    expect(await rowCounts(txn.transactionId)).toEqual({ dispute: 1, history: 1, evidence: 1 });
    const history = await db.appQuery(
      `select h.action, h.from_status, h.to_status, h.actor_type, h.actor_id from dispute_status_history h
       join dispute d on d.id = h.dispute_id where d.transaction_id = $1`,
      [txn.transactionId],
    );
    expect(history.rows).toEqual([
      {
        action: 'CREATE',
        from_status: null,
        to_status: 'SUBMITTED',
        actor_type: 'USER',
        actor_id: USER_A.userId,
      },
    ]);

    const lookup = upstreams.calls.find(
      (c) =>
        c.url.pathname === '/transactions' && c.url.searchParams.get('transactionIds') === txn.transactionId,
    );
    expect(lookup?.url.searchParams.get('userId')).toBe(USER_A.userId);
  });

  it('DisputeCreated carries ids and version only (no PII)', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const res = await post(svc, USER_A.token, txn.transactionId, {
      reasonCode: 'DUPLICATE',
      description: DESCRIPTION,
    });
    expect(res.statusCode).toBe(201);

    const message = svc.messages.find((m) => m.body.includes(txn.transactionId));
    expect(message?.queueUrl).toBe(QUEUE_URL);
    const event = JSON.parse(message?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(
      [
        'data',
        'disputeId',
        'eventId',
        'eventType',
        'occurredAt',
        'transactionId',
        'userId',
        'version',
      ].sort(),
    );
    expect(event).toMatchObject({
      eventType: 'DisputeCreated',
      disputeId: res.json().disputeId,
      transactionId: txn.transactionId,
      userId: USER_A.userId,
      version: 1,
      data: { fromStatus: null, toStatus: 'SUBMITTED', reasonCode: 'DUPLICATE' },
    });
    expect(Object.keys(event.data as object).sort()).toEqual(['fromStatus', 'reasonCode', 'toStatus']);
    expect(message?.body).not.toContain(DESCRIPTION);
  });

  it("user B on user A's transaction → 404 and nothing written", async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const res = await post(svc, USER_B.token, txn.transactionId, {
      reasonCode: 'FRAUD',
      description: DESCRIPTION,
    });
    expect(res.statusCode).toBe(404);
    expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
  });

  it.each([
    { code: 'CARD_EXPIRED', txn: {}, card: { expiryMonth: 1, expiryYear: 2020, expired: true }, body: {} },
    { code: 'TXN_NOT_POSTED', txn: { status: 'PENDING', postedAt: null }, card: {}, body: {} },
    { code: 'TXN_TYPE_NOT_DISPUTABLE', txn: { type: 'REFUND' }, card: {}, body: {} },
    {
      code: 'OUTSIDE_WINDOW',
      txn: { postedAt: daysAgo(130), transactionAt: daysAgo(131) },
      card: {},
      body: {},
    },
    { code: 'INVALID_REASON', txn: {}, card: {}, body: { reasonCode: 'BORED' } },
    { code: 'INVALID_DESCRIPTION', txn: {}, card: {}, body: { description: 'too short' } },
  ] as const)(
    'ineligible: $code → 422 NOT_ELIGIBLE decided by @cd/dispute-domain',
    async ({ code, txn, card, body }) => {
      const t = upstreams.addTransaction(USER_A.userId, txn, card);
      const res = await post(svc, USER_A.token, t.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
        ...body,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ type: 'urn:cd:problem:NOT_ELIGIBLE', code });
      expect(await rowCounts(t.transactionId)).toEqual(NO_ROWS);
    },
  );

  it('any existing dispute (even WITHDRAWN) → 409 ALREADY_DISPUTED', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    await db.appQuery(
      `insert into dispute (transaction_id, user_id, reason_code, description, status, created_by, updated_by)
       values ($1, $2, 'FRAUD', $3, 'WITHDRAWN', $4, $4)`,
      [txn.transactionId, USER_A.userId, DESCRIPTION, `USER:${USER_A.userId}`],
    );
    const res = await post(svc, USER_A.token, txn.transactionId, {
      reasonCode: 'FRAUD',
      description: DESCRIPTION,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ALREADY_DISPUTED' });
  });

  it('eligibility uses DB now(), not the task clock', async () => {
    const skewed = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      now: () => new Date('2099-06-01T00:00:00Z'),
    });
    try {
      const txn = upstreams.addTransaction(USER_A.userId);
      const res = await post(skewed, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await skewed.servers.close();
    }
  });

  it('service code holds no dispute-rule literals (window days come from @cd/dispute-domain)', async () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    const offenders = (
      await Promise.all(
        files.map(async (f) => ((await readFile(join(srcDir, f), 'utf8')).match(/\b120\b/) ? [f] : [])),
      )
    ).flat();
    expect(offenders).toEqual([]);
  });

  it.each([
    { name: 'disputedAmount', extra: { disputedAmount: '10.00' } },
    { name: 'any unknown field', extra: { priority: 'high' } },
    {
      name: 'unknown field inside a declaration',
      extra: { evidence: [declaration({ path: '/etc/passwd' })] },
    },
  ])('body with $name → 400, nothing written', async ({ extra }) => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const res = await post(svc, USER_A.token, txn.transactionId, {
      reasonCode: 'FRAUD',
      description: DESCRIPTION,
      ...extra,
    });
    expect(res.statusCode).toBe(400);
    expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
  });

  it.each([
    { name: '6 declarations', evidence: Array.from({ length: 6 }, () => declaration()) },
    { name: 'size > 10 MB', evidence: [declaration({ sizeBytes: 10_485_761 })] },
    { name: 'type not PDF/JPEG/PNG', evidence: [declaration({ contentType: 'application/x-msdownload' })] },
    { name: 'malformed sha256', evidence: [declaration({ sha256: FILE_SHA_HEX.toUpperCase() })] },
  ])('evidence with $name → 400, no dispute or evidence rows', async ({ evidence }) => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const res = await post(svc, USER_A.token, txn.transactionId, {
      reasonCode: 'FRAUD',
      description: DESCRIPTION,
      evidence,
    });
    expect(res.statusCode).toBe(400);
    expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
  });

  it('5 concurrent POSTs for one transaction → exactly one 201, the rest 409 ALREADY_DISPUTED', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(svc, USER_A.token, txn.transactionId, { reasonCode: 'FRAUD', description: DESCRIPTION }),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(
      results.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'ALREADY_DISPUTED'),
    ).toBe(true);
    expect(await rowCounts(txn.transactionId)).toEqual({ dispute: 1, history: 1, evidence: 0 });
  });

  it('a failure after the dispute insert rolls everything back', async () => {
    const failing = await startTestService({
      pool: poolFailingOn(db.appPool, 'insert into dispute_status_history'),
      upstreams,
      s3Endpoint: front.endpoint,
    });
    try {
      const txn = upstreams.addTransaction(USER_A.userId);
      const res = await post(failing, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
        evidence: [declaration()],
      });
      expect(res.statusCode).toBe(500);
      expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
      expect(failing.messages).toEqual([]);
    } finally {
      await failing.servers.close();
    }
  });

  it('publish failure is logged with the EventPublishFailed metric and the response is still 201', async () => {
    const attempts: number[] = [];
    const broken = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      send: async () => {
        attempts.push(attempts.length + 1);
        throw new Error('sqs unavailable');
      },
    });
    try {
      const txn = upstreams.addTransaction(USER_A.userId);
      const res = await post(broken, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
      });
      expect(res.statusCode).toBe(201);
      expect(attempts).toEqual([1, 2, 3]);
      expect(await rowCounts(txn.transactionId)).toEqual({ dispute: 1, history: 1, evidence: 0 });
      const failure = broken.logLines().find((l) => l.msg === 'event publish failed');
      expect(failure).toMatchObject({
        EventPublishFailed: 1,
        eventType: 'DisputeCreated',
        disputeId: res.json().disputeId,
      });
      expect(failure?._aws).toMatchObject({
        CloudWatchMetrics: [{ Metrics: [{ Name: 'EventPublishFailed' }] }],
      });
      expect(failure?.error).toEqual({ type: 'Error', message: 'sqs unavailable' });
    } finally {
      await broken.servers.close();
    }
  });

  it('a hanging SQS send holds the 201 no longer than the publish budget', async () => {
    const stuck = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      send: () => new Promise<void>(() => undefined),
    });
    try {
      const txn = upstreams.addTransaction(USER_A.userId);
      const started = Date.now();
      const res = await post(stuck, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
      });
      expect(res.statusCode).toBe(201);
      expect(Date.now() - started).toBeLessThan(2_500);
      const failure = stuck.logLines().find((l) => l.msg === 'event publish failed');
      expect(failure?.error).toMatchObject({ type: 'TimeoutError' });
    } finally {
      await stuck.servers.close();
    }
  });

  it('signing failure after commit → 503 UPLOAD_SIGNING_UNAVAILABLE; the dispute exists and the event was published', async () => {
    const unsignable = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      presign: async () => {
        throw new Error('credentials unavailable');
      },
    });
    try {
      const txn = upstreams.addTransaction(USER_A.userId);
      const res = await post(unsignable, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
        evidence: [declaration()],
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'UPLOAD_SIGNING_UNAVAILABLE' });
      expect(await rowCounts(txn.transactionId)).toEqual({ dispute: 1, history: 1, evidence: 1 });
      expect(unsignable.messages.map((m) => JSON.parse(m.body) as unknown)).toMatchObject([
        { eventType: 'DisputeCreated', transactionId: txn.transactionId },
      ]);
      const logged = unsignable.logLines().find((l) => l.msg === 'upload signing failed');
      expect(logged?.error).toEqual({ type: 'Error', message: 'credentials unavailable' });
      expect(JSON.stringify(logged)).not.toContain('receipt.pdf');
    } finally {
      await unsignable.servers.close();
    }
  });
});

describe('upstream failures and isolation', () => {
  const withService = async (
    fault: NonNullable<Parameters<typeof startTestService>[0]['fault']>,
    run: (service: TestService) => Promise<void>,
  ): Promise<void> => {
    const service = await startTestService({
      pool: db.appPool,
      upstreams,
      s3Endpoint: front.endpoint,
      fault,
    });
    try {
      await run(service);
    } finally {
      await service.servers.close();
    }
  };

  const isPath = (url: URL, origin: string, pathname: string) =>
    url.origin === origin && url.pathname === pathname;
  const scopeOf = (body: string) => new URLSearchParams(body).get('scope');

  it.each([
    {
      name: 'transactions returns 5xx',
      fault: (url: URL) =>
        isPath(url, URLS.transactions, '/transactions') ? Promise.resolve(json(502, {})) : undefined,
    },
    {
      name: 'transactions returns a malformed body',
      fault: (url: URL) =>
        isPath(url, URLS.transactions, '/transactions')
          ? Promise.resolve(json(200, { items: [{ transactionId: 'not-a-uuid' }] }))
          : undefined,
    },
    {
      name: 'the token endpoint is unavailable for transactions/read',
      fault: (url: URL, body: string) =>
        url.href === URLS.token && scopeOf(body) === 'transactions/read'
          ? Promise.resolve(json(503, {}))
          : undefined,
    },
  ])('$name → 503, nothing written', async ({ fault }) => {
    await withService(fault, async (service) => {
      const txn = upstreams.addTransaction(USER_A.userId);
      const res = await post(service, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
    });
  });

  it.each([
    { name: 'transactions', hangs: (url: URL) => isPath(url, URLS.transactions, '/transactions') },
    { name: 'users', hangs: (url: URL) => isPath(url, URLS.users, '/cards') },
    { name: 'auth /validate', hangs: (url: URL) => isPath(url, URLS.auth, '/validate') },
  ])('$name hanging → 503 within the 2 s overall deadline, nothing written', async ({ hangs }) => {
    await withService(
      (url, _body, init) => (hangs(url) ? hang(url, init) : undefined),
      async (service) => {
        const txn = upstreams.addTransaction(USER_A.userId);
        const started = Date.now();
        const res = await post(service, USER_A.token, txn.transactionId, {
          reasonCode: 'FRAUD',
          description: DESCRIPTION,
        });
        expect(res.statusCode).toBe(503);
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
      },
    );
  });

  it('users returning the card under a different userId → 404, nothing written', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    await withService(
      (url) =>
        isPath(url, URLS.users, '/cards')
          ? Promise.resolve(
              json(200, { cards: [{ ...upstreams.cardOf(txn.cardId), userId: USER_B.userId }] }),
            )
          : undefined,
      async (service) => {
        const res = await post(service, USER_A.token, txn.transactionId, {
          reasonCode: 'FRAUD',
          description: DESCRIPTION,
        });
        expect(res.statusCode).toBe(404);
        expect(await rowCounts(txn.transactionId)).toEqual(NO_ROWS);
      },
    );
  });

  it('each callee gets a token carrying only its own scope', async () => {
    const isolated = createFakeUpstreams();
    const service = await startTestService({
      pool: db.appPool,
      upstreams: isolated,
      s3Endpoint: front.endpoint,
    });
    try {
      const txn = isolated.addTransaction(USER_A.userId);
      const res = await post(service, USER_A.token, txn.transactionId, {
        reasonCode: 'FRAUD',
        description: DESCRIPTION,
      });
      expect(res.statusCode).toBe(201);

      const requested = isolated.calls.filter((c) => c.url.href === URLS.token).map((c) => scopeOf(c.body));
      expect([...requested].sort()).toEqual(['auth/validate', 'transactions/read', 'users/cards.read']);
      const authorizationFor = (origin: string, pathname: string) => [
        ...new Set(isolated.calls.filter((c) => isPath(c.url, origin, pathname)).map((c) => c.authorization)),
      ];
      expect(authorizationFor(URLS.auth, '/validate')).toEqual(['Bearer svc:auth/validate']);
      expect(authorizationFor(URLS.transactions, '/transactions')).toEqual(['Bearer svc:transactions/read']);
      expect(authorizationFor(URLS.users, '/cards')).toEqual(['Bearer svc:users/cards.read']);
    } finally {
      await service.servers.close();
    }
  });

  it('the unique constraint the repo matches is the one the migration creates', async () => {
    const res = await db.appQuery(
      `select conname from pg_constraint
       where conrelid = 'dispute'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (transaction_id)'`,
    );
    expect(res.rows).toEqual([{ conname: TRANSACTION_UNIQUE }]);
  });
});

describe('presigned upload URLs', () => {
  const createWithUpload = async (): Promise<{ readonly disputeId: string; readonly upload: Upload }> => {
    const txn = upstreams.addTransaction(USER_A.userId);
    const res = await post(svc, USER_A.token, txn.transactionId, {
      reasonCode: 'NOT_RECEIVED',
      description: DESCRIPTION,
      evidence: [declaration({ fileName: 'my receipt.pdf' })],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { disputeId: body.disputeId, upload: (body.uploads as Upload[])[0] as Upload };
  };

  it('signs content-length, content-type, host and x-amz-checksum-sha256 as headers (no checksum in the query), 10 min', async () => {
    const { disputeId, upload } = await createWithUpload();
    const url = new URL(upload.url);
    expect(upload.method).toBe('PUT');
    expect(url.pathname).toBe(`/${QUARANTINE_BUCKET}/evidence/${disputeId}/${upload.evidenceId}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-checksum-sha256',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect([...url.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    expect(upload.url).not.toMatch(/receipt/i);
  });

  it('S3 accepts the PUT with exactly the signed headers (stored in moto)', async () => {
    const { disputeId, upload } = await createWithUpload();
    const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: FILE });
    expect(res.status).toBe(200);
    const head = await headObject(
      moto.endpoint,
      QUARANTINE_BUCKET,
      `evidence/${disputeId}/${upload.evidenceId}`,
    );
    expect(head.ContentType).toBe('application/pdf');
    expect(head.ContentLength).toBe(FILE.length);
  });

  const bigger = Buffer.concat([FILE, Buffer.from('extra bytes')]);
  it.each([
    { name: 'a different Content-Type', headers: { 'Content-Type': 'image/png' }, body: FILE, status: 403 },
    {
      name: 'a different length',
      headers: {
        'Content-Length': String(bigger.length),
        'x-amz-checksum-sha256': createHash('sha256').update(bigger).digest('base64'),
      },
      body: bigger,
      status: 403,
    },
    {
      name: 'a different checksum',
      headers: { 'x-amz-checksum-sha256': createHash('sha256').update('other').digest('base64') },
      body: FILE,
      status: 403,
    },
    {
      name: 'other bytes under the signed checksum',
      headers: {},
      body: Buffer.from('%PDF-1.7\nRECEIPT FOR DISPUTED PURCHASE\n'),
      status: 400,
    },
  ])('S3 rejects $name (SigV4 + checksum verified in front of moto)', async ({ headers, body, status }) => {
    const { upload } = await createWithUpload();
    const res = await fetch(upload.url, { method: 'PUT', headers: { ...upload.headers, ...headers }, body });
    expect(res.status).toBe(status);
  });
});

describe('ports and placeholders', () => {
  it('public port: user token reaches the P-03 placeholders (501), a service token is 403', async () => {
    const id = randomUUID();
    const inject = (method: 'GET', url: string, token: string) =>
      svc.servers.public.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
    expect((await inject('GET', '/disputes', USER_A.token)).statusCode).toBe(501);
    expect((await inject('GET', `/dispute/${id}`, USER_A.token)).statusCode).toBe(501);
    expect((await inject('GET', '/disputes', SERVICE_CALLER.token)).statusCode).toBe(403);
  });

  it('service port: GET /disputes needs a service token with disputes/read (501 placeholder); a user token is 403', async () => {
    const inject = (token: string) =>
      svc.servers.service.inject({
        method: 'GET',
        url: '/disputes',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await inject(SERVICE_CALLER.token)).statusCode).toBe(501);
    expect((await inject(USER_A.token)).statusCode).toBe(403);
    expect(
      (await svc.servers.service.inject({ method: 'POST', url: `/dispute/${randomUUID()}` })).statusCode,
    ).toBe(404);
  });
});

describe('repo surface for P-02/P-03', () => {
  it('lockForUpdate is owner-scoped, updateWithVersion rejects a stale version, findLatestWithHistory returns the timeline', async () => {
    const txn = upstreams.addTransaction(USER_A.userId);
    expect(
      (await post(svc, USER_A.token, txn.transactionId, { reasonCode: 'FRAUD', description: DESCRIPTION }))
        .statusCode,
    ).toBe(201);
    const repo = createDisputeRepo(db.appPool);

    const outcome = await repo.transact(async (tx) => {
      const notMine = await tx.lockForUpdate({ transactionId: txn.transactionId, userId: USER_B.userId });
      const mine = await tx.lockForUpdate({ transactionId: txn.transactionId, userId: USER_A.userId });
      if (mine === null) throw new Error('dispute missing');
      const stale = await tx.updateWithVersion({
        disputeRowId: mine.id,
        expectedVersion: 7,
        changes: { description: 'stale edit attempt' },
        updatedBy: `USER:${USER_A.userId}`,
      });
      const fresh = await tx.updateWithVersion({
        disputeRowId: mine.id,
        expectedVersion: 1,
        changes: { status: 'WITHDRAWN' },
        updatedBy: `USER:${USER_A.userId}`,
      });
      await tx.insertHistory({
        disputeRowId: mine.id,
        action: 'WITHDRAW',
        fromStatus: 'SUBMITTED',
        toStatus: 'WITHDRAWN',
        actorType: 'USER',
        actorId: USER_A.userId,
      });
      return { ok: true as const, value: { notMine, stale, fresh } };
    });
    expect(outcome.ok && outcome.value.notMine).toBeNull();
    expect(outcome.ok && outcome.value.stale).toEqual({ ok: false, error: 'STALE_VERSION' });
    expect(outcome.ok && outcome.value.fresh).toMatchObject({
      ok: true,
      value: { status: 'WITHDRAWN', version: 2 },
    });

    expect(
      await repo.findLatestWithHistory({ transactionId: txn.transactionId, userId: USER_B.userId }),
    ).toBeNull();
    const found = await repo.findLatestWithHistory({
      transactionId: txn.transactionId,
      userId: USER_A.userId,
    });
    expect(found?.dispute).toMatchObject({ status: 'WITHDRAWN', version: 2 });
    expect(found?.history.map((h) => h.action)).toEqual(['CREATE', 'WITHDRAW']);
  });
});
