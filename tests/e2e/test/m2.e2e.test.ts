import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminRows,
  clearSentEmails,
  driverInvoke,
  inNetwork,
  INTAKE_DEAD_LETTERS,
  NOTIFICATIONS_DEAD_LETTERS,
  objectExists,
  putQuarantineObject,
  sendNotification,
  sentEmails,
  sha256Base64,
  sha256Hex,
  takeFromDlq,
  until,
  type SentEmail,
} from '../src/async.ts';
import { call, listTransactions, serviceToken, URLS, userToken, type Json, type Txn } from '../src/stack.ts';

const QUARANTINE = 'cd-evidence-quarantine';
const EVIDENCE = 'cd-evidence';
const ERASED = '[erased]';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const PDF = text(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
// Split so antivirus scanners do not flag this source file.
const EICAR = text(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join(''));
const RENAMED_EXE = text(`MZ\x90\x00 This program cannot be run in DOS mode. ${'x'.repeat(64)}`);

type File = { readonly fileName: string; readonly bytes: Uint8Array };

const declare = ({ fileName, bytes }: File) => ({
  fileName,
  contentType: 'application/pdf',
  sizeBytes: bytes.length,
  sha256: sha256Hex(bytes),
});

const uploadFor = (uploads: readonly Json[], bytes: Uint8Array): Json => {
  const upload = uploads.find((candidate) => {
    const headers = Object.fromEntries(Object.entries(candidate['headers']).map(([k, v]) => [k.toLowerCase(), v]));
    return headers['x-amz-checksum-sha256'] === sha256Base64(bytes);
  });
  if (upload === undefined) throw new Error('no presigned upload matches the declared checksum');
  return upload;
};

const put = (upload: Json, bytes: Uint8Array): Promise<Response> =>
  fetch(upload['url'], { method: upload['method'], headers: upload['headers'], body: bytes });

let tokenA: string;
let userIdA: string;
let contactEmailA: string;

const freshDisputable = async (): Promise<Txn> => {
  const me = (await call('GET', `${URLS.users}/me`, { token: tokenA })).body;
  const cards: Json[] = me['accounts'].flatMap((account: Json) => account['cards']);
  const live = cards.find((card) => card['expired'] === false && card['status'] === 'ACTIVE') ?? {};
  const rows = await listTransactions(tokenA, { cardId: live['cardId'] });
  const row = rows.find((item) => item.disputable.allowed);
  if (row === undefined) throw new Error('no disputable transaction left for user A on the live card; reseed');
  return row;
};

const detail = async (transactionId: string): Promise<Json> => {
  const reply = await call('GET', `${URLS.disputes}/dispute/${transactionId}`, { token: tokenA });
  expect(reply.status).toBe(200);
  return reply.body;
};

const mailsFor = async (disputeId: string): Promise<readonly SentEmail[]> =>
  (await sentEmails()).filter((mail) => mail.text.includes(disputeId));

const waitForMail = (disputeId: string, subject: string, extra = ''): Promise<SentEmail> =>
  until(`mail "${subject}" ${extra} for dispute ${disputeId}`, async () =>
    (await mailsFor(disputeId)).find((mail) => mail.subject === subject && mail.text.includes(extra)),
  );

beforeAll(async () => {
  tokenA = await userToken('A');
  const me = (await call('GET', `${URLS.users}/me`, { token: tokenA })).body;
  userIdA = me['userId'];
  const notifier = await serviceToken('svc-notifier');
  const contact = inNetwork('users', 'GET', `/users/${userIdA}/contact`, { token: notifier });
  contactEmailA = contact.body['email'];
  await clearSentEmails();
}, 60_000);

describe('M2 outcome: evidence uploaded with the presigned PUT is scanned, checked and promoted', () => {
  const pdf: File = { fileName: 'receipt-e2e.pdf', bytes: PDF };
  const eicar: File = { fileName: 'eicar-e2e.pdf', bytes: EICAR };
  const exe: File = { fileName: 'renamed-e2e.pdf', bytes: RENAMED_EXE };
  let target: Txn;
  let disputeId: string;
  let uploads: readonly Json[];
  let evidenceIds: { pdf: string; eicar: string; exe: string };
  let final: Json;

  it('creates a dispute with three declared files and the real bytes go up with exactly the returned headers', async () => {
    target = await freshDisputable();
    const reply = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}`, {
      token: tokenA,
      body: {
        reasonCode: 'NOT_RECEIVED',
        description: `e2e async flow ${new Date().toISOString()}`,
        evidence: [declare(pdf), declare(eicar), declare(exe)],
      },
    });
    expect(reply.status).toBe(201);
    disputeId = reply.body['disputeId'];
    uploads = reply.body['uploads'];
    expect(uploads).toHaveLength(3);
    evidenceIds = {
      pdf: uploadFor(uploads, pdf.bytes)['evidenceId'],
      eicar: uploadFor(uploads, eicar.bytes)['evidenceId'],
      exe: uploadFor(uploads, exe.bytes)['evidenceId'],
    };

    await until(`submitted mail for ${disputeId}`, async () => (await mailsFor(disputeId)).length > 0);

    for (const file of [pdf, eicar, exe]) {
      const upload = uploadFor(uploads, file.bytes);
      expect((await put(upload, file.bytes)).status).toBe(200);
    }
    expect(await objectExists(QUARANTINE, `intake/${target.transactionId}/${evidenceIds.pdf}`)).toBe(true);
  });

  it('within a bounded wait every file leaves PENDING', async () => {
    final = await until(
      'all evidence settled',
      async () => {
        const current = await detail(target.transactionId);
        return current['evidence'].every((item: Json) => item['status'] !== 'PENDING') ? current : undefined;
      },
      60_000,
    );
    const status = (id: string): string => final['evidence'].find((item: Json) => item['evidenceId'] === id)['status'];
    expect(status(evidenceIds.pdf)).toBe('STORED');
    expect(status(evidenceIds.eicar)).toBe('REJECTED');
    expect(status(evidenceIds.exe)).toBe('REJECTED');
  }, 90_000);

  it('the clean PDF has EVIDENCE_ADDED with its file name, sits at evidence/{disputeId}/{evidenceId} and is gone from quarantine', async () => {
    const added = final['timeline'].find((event: Json) => event['type'] === 'EVIDENCE_ADDED');
    expect(added).toMatchObject({ by: expect.any(String), detail: { fileName: pdf.fileName } });
    expect(await objectExists(EVIDENCE, `evidence/${disputeId}/${evidenceIds.pdf}`)).toBe(true);
    await until('quarantine object removed', async () =>
      (await objectExists(QUARANTINE, `intake/${target.transactionId}/${evidenceIds.pdf}`)) ? undefined : true,
    );
  });

  it('EICAR is rejected as MALWARE and a renamed exe as TYPE_MISMATCH, with nothing promoted', async () => {
    const rejected = final['timeline'].filter((event: Json) => event['type'] === 'EVIDENCE_REJECTED');
    expect(rejected.map((event: Json) => event['detail'])).toEqual(
      expect.arrayContaining([
        { fileName: eicar.fileName, reason: 'MALWARE' },
        { fileName: exe.fileName, reason: 'TYPE_MISMATCH' },
      ]),
    );
    expect(await objectExists(EVIDENCE, `evidence/${disputeId}/${evidenceIds.eicar}`)).toBe(false);
    expect(await objectExists(EVIDENCE, `evidence/${disputeId}/${evidenceIds.exe}`)).toBe(false);
  });
});

describe('M2 outcome: re-declaring a pending file is retry-safe', () => {
  it('the same declaration returns the same evidenceId, a different file gets a new one', async () => {
    const target = await freshDisputable();
    const file: File = { fileName: 'pending-e2e.pdf', bytes: text(`%PDF-1.4 pending ${randomUUID()}`) };
    const created = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}`, {
      token: tokenA,
      body: { reasonCode: 'FRAUD', description: `e2e re-declare ${new Date().toISOString()}`, evidence: [declare(file)] },
    });
    expect(created.status).toBe(201);
    const first = created.body['uploads'][0]['evidenceId'];

    const again = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}/evidence`, {
      token: tokenA,
      body: { evidence: [declare(file)] },
    });
    expect(again.status).toBe(201);
    expect(again.body['uploads'][0]['evidenceId']).toBe(first);

    const other: File = { fileName: 'other-e2e.pdf', bytes: text(`%PDF-1.4 other ${randomUUID()}`) };
    const different = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}/evidence`, {
      token: tokenA,
      body: { evidence: [declare(other)] },
    });
    expect(different.status).toBe(201);
    expect(different.body['uploads'][0]['evidenceId']).not.toBe(first);
  });
});

describe('M2 outcome: the customer is emailed on every event, and only the owner', () => {
  let target: Txn;
  let disputeId: string;

  it('mail for submitted, evidence added and evidence rejected arrives for a fresh dispute', async () => {
    target = await freshDisputable();
    const good: File = { fileName: 'mail-ok-e2e.pdf', bytes: text(`%PDF-1.4 mail ${randomUUID()}`) };
    const bad: File = { fileName: 'mail-bad-e2e.pdf', bytes: EICAR };
    const reply = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}`, {
      token: tokenA,
      body: { reasonCode: 'DUPLICATE', description: `e2e mail flow ${new Date().toISOString()}`, evidence: [declare(good), declare(bad)] },
    });
    expect(reply.status).toBe(201);
    disputeId = reply.body['disputeId'];
    const uploads: Json[] = reply.body['uploads'];
    for (const file of [good, bad]) expect((await put(uploadFor(uploads, file.bytes), file.bytes)).status).toBe(200);

    await waitForMail(disputeId, 'We have received your dispute');
    await waitForMail(disputeId, 'Your evidence has been added');
    const rejected = await waitForMail(disputeId, 'We could not accept a file you uploaded');
    expect(rejected.text).toContain('did not pass our security scan');
  }, 90_000);

  it('an edit sends the updated mail', async () => {
    const current = await call('GET', `${URLS.disputes}/dispute/${target.transactionId}`, { token: tokenA });
    const reply = await call('PUT', `${URLS.disputes}/dispute/${target.transactionId}`, {
      token: tokenA,
      headers: { 'if-match': current.headers.get('etag') ?? '' },
      body: { action: 'EDIT', description: `e2e mail flow edited ${new Date().toISOString()}` },
    });
    expect(reply.status).toBe(200);
    await waitForMail(disputeId, 'Your dispute has been updated');
  });

  it('a withdrawal sends the withdrawn mail', async () => {
    const current = await call('GET', `${URLS.disputes}/dispute/${target.transactionId}`, { token: tokenA });
    const reply = await call('PUT', `${URLS.disputes}/dispute/${target.transactionId}`, {
      token: tokenA,
      headers: { 'if-match': current.headers.get('etag') ?? '' },
      body: { action: 'WITHDRAW' },
    });
    expect(reply.status).toBe(200);
    await waitForMail(disputeId, 'Your dispute has been withdrawn');
  });

  it("every mail for the dispute went to A's contact address and nobody else", async () => {
    expect(contactEmailA).toMatch(/@/);
    const mails = await mailsFor(disputeId);
    expect(mails.length).toBeGreaterThanOrEqual(5);
    for (const mail of mails) expect(mail.to).toEqual([contactEmailA]);
  });
});

describe('M2 outcome: retention sweeper via the Lambda RIE on rows backdated with the admin connection', () => {
  const run = randomUUID();
  type Seeded = { readonly disputeId: string; readonly transactionId: string };

  const seed = (
    label: string,
    spec: {
      readonly status: string;
      readonly createdDaysAgo: number;
      readonly resolvedDaysAgo?: number;
      readonly evidence: ReadonlyArray<{ readonly status: string; readonly ageDays: number; readonly fileName: string }>;
    },
  ): Seeded => {
    const resolved = spec.resolvedDaysAgo === undefined ? 'null' : `now() - interval '${spec.resolvedDaysAgo} days'`;
    const evidenceRows = spec.evidence
      .map(
        (item, index) =>
          `((select id from d), '${item.fileName}', 'application/pdf', 10, repeat('a', 64), ` +
          `${item.status === 'STORED' ? `'evidence/e2e/${run}-${index}'` : 'null'}, '${item.status}', ` +
          `${item.status === 'REJECTED' ? "'MALWARE'" : 'null'}, now() - interval '${item.ageDays} days')`,
      )
      .join(', ');
    const rows = adminRows(
      `with d as (
        insert into disputes.dispute (transaction_id, user_id, reason_code, description, status, version, resolved_at,
                                      resolution_note, created_by, updated_by, created_at)
        values (gen_random_uuid(), '${userIdA}', 'FRAUD', 'e2e retention ${label} ${run}', '${spec.status}', 3, ${resolved},
                ${spec.resolvedDaysAgo === undefined ? 'null' : "'agent note to erase'"}, 'USER:e2e', 'AGENT:e2e',
                now() - interval '${spec.createdDaysAgo} days')
        returning id, dispute_id, transaction_id),
      h as (
        insert into disputes.dispute_status_history (dispute_id, action, from_status, to_status, actor_type, actor_id,
                                                     note, before, after, created_at)
        select id, 'CREATE', null, 'SUBMITTED', 'USER', 'e2e', 'history note', '{"a":1}', '{"b":2}',
               now() - interval '${spec.createdDaysAgo} days' from d
        returning 1),
      e as (
        insert into disputes.dispute_evidence (dispute_id, file_name, declared_content_type, declared_size_bytes,
                                               declared_sha256, s3_key, status, rejection_reason, created_at)
        values ${evidenceRows}
        returning 1)
      select json_agg(r) from (select dispute_id as "disputeId", transaction_id as "transactionId" from d) r;`,
      { raw: true },
    );
    return rows[0] as Seeded;
  };

  const snapshot = (disputeId: string): Json =>
    adminRows(`
      select d.status, d.version, d.description, d.resolution_note as "resolutionNote",
        (select json_agg(json_build_object('note', h.note, 'before', h.before, 'after', h.after))
           from disputes.dispute_status_history h where h.dispute_id = d.id) as history,
        (select json_agg(json_build_object('fileName', e.file_name, 'status', e.status, 's3Key', e.s3_key,
                                           'reason', e.rejection_reason) order by e.id)
           from disputes.dispute_evidence e where e.dispute_id = d.id) as evidence
      from disputes.dispute d where d.dispute_id = '${disputeId}'`)[0] as Json;

  let pending: Seeded;
  let old: Seeded;
  let nearly: Seeded;
  let stale: Seeded;

  beforeAll(() => {
    pending = seed('pending', {
      status: 'SUBMITTED',
      createdDaysAgo: 2,
      evidence: [
        { status: 'PENDING', ageDays: 2, fileName: 'slot-old.pdf' },
        { status: 'PENDING', ageDays: 0, fileName: 'slot-new.pdf' },
      ],
    });
    old = seed('resolved-366', {
      status: 'RESOLVED_ACCEPTED',
      createdDaysAgo: 400,
      resolvedDaysAgo: 366,
      evidence: [
        { status: 'STORED', ageDays: 400, fileName: 'secret-receipt.pdf' },
        { status: 'REJECTED', ageDays: 400, fileName: 'secret-virus.pdf' },
      ],
    });
    nearly = seed('resolved-364', {
      status: 'RESOLVED_REJECTED',
      createdDaysAgo: 400,
      resolvedDaysAgo: 364,
      evidence: [{ status: 'STORED', ageDays: 400, fileName: 'keep-receipt.pdf' }],
    });
    stale = seed('submitted-old', {
      status: 'SUBMITTED',
      createdDaysAgo: 400,
      evidence: [{ status: 'STORED', ageDays: 400, fileName: 'open-receipt.pdf' }],
    });
  });

  it('one invocation expires the 2-day slot, erases the 366-day dispute and leaves the other two untouched', () => {
    const before = { nearly: snapshot(nearly.disputeId), stale: snapshot(stale.disputeId) };

    const result = driverInvoke('retention-sweeper', {});
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ expired: expect.any(Number), erased: expect.any(Number) });

    const slots = snapshot(pending.disputeId);
    expect(slots['status']).toBe('SUBMITTED');
    expect(slots['evidence'].map((item: Json) => [item['fileName'], item['status']])).toEqual([
      ['slot-old.pdf', 'EXPIRED'],
      ['slot-new.pdf', 'PENDING'],
    ]);

    const erased = snapshot(old.disputeId);
    expect(erased).toMatchObject({ status: 'RESOLVED_ACCEPTED', version: 3, description: ERASED, resolutionNote: null });
    expect(erased['history']).toEqual([{ note: null, before: null, after: null }]);
    expect(erased['evidence']).toEqual([
      { fileName: ERASED, status: 'ERASED', s3Key: null, reason: null },
      { fileName: ERASED, status: 'ERASED', s3Key: null, reason: null },
    ]);

    expect(snapshot(nearly.disputeId)).toEqual(before.nearly);
    expect(snapshot(nearly.disputeId)).toMatchObject({ description: expect.stringContaining('resolved-364'), resolutionNote: 'agent note to erase' });
    expect(snapshot(stale.disputeId)).toEqual(before.stale);
    expect(snapshot(stale.disputeId)['evidence'][0]).toMatchObject({ fileName: 'open-receipt.pdf', status: 'STORED' });
  });

  it('the customer API shows the tombstones for the erased dispute', async () => {
    const reply = await call('GET', `${URLS.disputes}/dispute/${old.transactionId}`, { token: tokenA });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ description: ERASED, resolutionNote: null });
    expect(reply.body['evidence'].map((item: Json) => [item['fileName'], item['status']])).toEqual([
      [ERASED, 'ERASED'],
      [ERASED, 'ERASED'],
    ]);
  });

  it('a second sweep changes nothing (idempotent)', () => {
    const first = snapshot(old.disputeId);
    const result = driverInvoke('retention-sweeper', {});
    expect(result.exitCode, result.stderr).toBe(0);
    expect(snapshot(old.disputeId)).toEqual(first);
  });
});

describe('M2 outcome: poison messages end in the dead-letter queues', () => {
  it('a garbage body and a well-formed event for an unknown user both reach dispute-notifications-dlq', async () => {
    const marker = randomUUID();
    const unknownEventId = randomUUID();
    await sendNotification(`not json at all ${marker}`);
    await sendNotification(
      JSON.stringify({
        eventId: unknownEventId,
        eventType: 'DisputeCreated',
        occurredAt: new Date().toISOString(),
        disputeId: randomUUID(),
        transactionId: randomUUID(),
        userId: randomUUID(),
        version: 1,
        data: { fromStatus: null, toStatus: 'SUBMITTED', reasonCode: 'FRAUD' },
      }),
    );

    // MaxReceive 5 with a 5 s visibility timeout takes about 25 s to redrive.
    expect(await takeFromDlq(NOTIFICATIONS_DEAD_LETTERS, marker, 90_000)).toContain(marker);
    expect(await takeFromDlq(NOTIFICATIONS_DEAD_LETTERS, unknownEventId, 90_000)).toContain(unknownEventId);
  }, 200_000);

  it('garbage given to the intake RIE fails the invocation, and a scan event for a bad key is parked in evidence-intake-dlq', async () => {
    const direct = driverInvoke('evidence-intake', { garbage: true });
    expect(direct.exitCode).toBe(1);

    // The CLI does one plain invoke; retries and the DLQ belong to the scan-stub emulation, so drive that path.
    const key = `intake/e2e-garbage-${randomUUID()}`;
    await putQuarantineObject(key, text('not an evidence upload'));
    expect(await takeFromDlq(INTAKE_DEAD_LETTERS, key, 60_000)).toContain(key);
  }, 90_000);
});

describe('V-10: service port authorization from inside the compose network', () => {
  const UNKNOWN = randomUUID();
  let user: string;
  let notifier: string;
  let intake: string;

  beforeAll(async () => {
    [notifier, intake] = await Promise.all([serviceToken('svc-notifier'), serviceToken('svc-evidence-intake')]);
    user = tokenA;
  });

  it('a user token is refused with 403 on a disputes service route and on the users contact route', () => {
    expect(inNetwork('disputes', 'GET', `/disputes?userId=${userIdA}&transactionIds=${UNKNOWN}`, { token: user }).status).toBe(403);
    expect(inNetwork('users', 'GET', `/users/${userIdA}/contact`, { token: user }).status).toBe(403);
  });

  it('no token is refused with 401 on both', () => {
    expect(inNetwork('disputes', 'GET', `/disputes?userId=${userIdA}&transactionIds=${UNKNOWN}`).status).toBe(401);
    expect(inNetwork('users', 'GET', `/users/${userIdA}/contact`).status).toBe(401);
  });

  it('svc-notifier lacks the scope for PUT evidence (403) while svc-evidence-intake reaches the route (404 for an unknown item)', () => {
    const path = `/dispute/${UNKNOWN}/evidence/${randomUUID()}`;
    const body = { result: 'REJECTED', reason: 'MALWARE' };
    expect(inNetwork('disputes', 'PUT', path, { token: notifier, body }).status).toBe(403);
    expect(inNetwork('disputes', 'PUT', path, { token: intake, body }).status).toBe(404);
  });

  it('svc-evidence-intake lacks the scope for the contact route (403)', () => {
    expect(inNetwork('users', 'GET', `/users/${userIdA}/contact`, { token: intake }).status).toBe(403);
  });

  it('svc-notifier reads the contact of A (200) and gets 404 for an unknown uuid', () => {
    const found = inNetwork('users', 'GET', `/users/${userIdA}/contact`, { token: notifier });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ userId: userIdA, email: contactEmailA });
    expect(inNetwork('users', 'GET', `/users/${UNKNOWN}/contact`, { token: notifier }).status).toBe(404);
  });
});
