import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminExec,
  adminRows,
  driverInvoke,
  objectExists,
  objectVersionKeys,
  sha256Hex,
  startService,
  stopService,
  until,
} from '../src/async.ts';
import { agentToken, call, freshDisputable, serviceToken, URLS, userToken, type Json, type Reply } from '../src/stack.ts';

const EVIDENCE = 'cd-evidence';
const AGENT_E_SUB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RATE_CAP = 30;

let tokenA: string;
let agentE: string;
let agentIdE: string;

const pdfBytes = (): Uint8Array =>
  new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n% e2e ${randomUUID()}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

const declare = (fileName: string, bytes: Uint8Array) => ({
  fileName,
  contentType: 'application/pdf',
  sizeBytes: bytes.length,
  sha256: sha256Hex(bytes),
});

const download = (transactionId: string, evidenceId: string, token = agentE): Promise<Reply> =>
  call('GET', `${URLS.disputes}/agent/disputes/${transactionId}/evidence/${evidenceId}/download`, { token });

const auditRows = (evidenceId: string): readonly Json[] =>
  adminRows(`
    select v.agent_id as "agentId", v.viewed_at as "viewedAt"
      from disputes.evidence_view v join disputes.dispute_evidence e on e.id = v.evidence_id
     where e.evidence_id = '${evidenceId}'`);

const raiseDispute = async (
  label: string,
  bytes: Uint8Array,
): Promise<{ readonly disputeId: string; readonly transactionId: string; readonly upload: Json }> => {
  const target = await freshDisputable(tokenA);
  const reply = await call('POST', `${URLS.disputes}/dispute/${target.transactionId}`, {
    token: tokenA,
    body: {
      reasonCode: 'NOT_RECEIVED',
      description: `e2e evidence download ${label} ${new Date().toISOString()}`,
      evidence: [declare(`${label}-e2e.pdf`, bytes)],
    },
  });
  expect(reply.status).toBe(201);
  return { disputeId: reply.body['disputeId'], transactionId: target.transactionId, upload: reply.body['uploads'][0] };
};

beforeAll(async () => {
  [tokenA, agentE] = await Promise.all([userToken('A'), agentToken('E')]);
  agentIdE = adminRows(`select agent_id as "agentId" from auth.agent_identity where cognito_sub = '${AGENT_E_SUB}'`)[0]?.[
    'agentId'
  ];
  expect(agentIdE).toEqual(expect.any(String));
}, 60_000);

// Needs the evidence-intake, evidence-viewer and retention-sweeper images running under the RIE (docker-compose.lambdas.yml).
describe('M6 outcome: an agent downloads the stored file the customer uploaded, and erasure deletes its bytes', () => {
  const bytes = pdfBytes();
  let disputeId: string;
  let transactionId: string;
  let evidenceId: string;

  it('the customer uploads a PDF through the presigned PUT and intake stores it', async () => {
    const raised = await raiseDispute('stored', bytes);
    ({ disputeId, transactionId } = raised);
    evidenceId = raised.upload['evidenceId'];
    const put = await fetch(raised.upload['url'], { method: raised.upload['method'], headers: raised.upload['headers'], body: bytes });
    expect(put.status).toBe(200);

    await until(
      'the evidence to be STORED',
      async () => {
        const detail = await call('GET', `${URLS.disputes}/dispute/${transactionId}`, { token: tokenA });
        return detail.body['evidence'].find((item: Json) => item['evidenceId'] === evidenceId)?.['status'] === 'STORED';
      },
      60_000,
    );
    expect(await objectExists(EVIDENCE, `evidence/${disputeId}/${evidenceId}`)).toBe(true);
  }, 90_000);

  it('the agent gets a 60 s link whose bytes equal the upload, served as a no-store attachment, and one audit row', async () => {
    const before = auditRows(evidenceId).length;
    const reply = await download(transactionId, evidenceId);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(reply.body).sort()).toEqual(['expiresAt', 'url']);
    const ttlMs = Date.parse(reply.body['expiresAt']) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(60_000);

    const file = await fetch(reply.body['url']);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="${evidenceId}.pdf"`);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('cache-control')).toBe('no-store');

    const rows = auditRows(evidenceId);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ agentId: agentIdE });
  });

  it('after the sweeper erases the resolved dispute the download is 409 and no version of the bytes is left', async () => {
    for (const path of ['review', 'resolution']) {
      const detail = (await call('GET', `${URLS.disputes}/agent/disputes/${transactionId}`, { token: agentE })).body;
      const expected = { expectedVersion: detail['version'], expectedEvidenceDigest: detail['evidenceDigest'] };
      const body = path === 'review' ? expected : { ...expected, outcome: 'REJECTED', note: 'Resolved for the erasure e2e' };
      expect((await call('PUT', `${URLS.disputes}/agent/disputes/${transactionId}/${path}`, { token: agentE, body })).status).toBe(200);
    }
    adminExec(`update disputes.dispute set resolved_at = now() - interval '366 days' where dispute_id = '${disputeId}';`);

    const sweep = driverInvoke('retention-sweeper', {});
    expect(sweep.exitCode, sweep.stderr).toBe(0);

    const reply = await download(transactionId, evidenceId);
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'EVIDENCE_NOT_STORED' });
    expect(await objectVersionKeys(EVIDENCE, `evidence/${disputeId}/`)).toEqual([]);
  }, 60_000);
});

describe('M6: refusals before any link is minted', () => {
  let transactionId: string;
  let pendingId: string;
  let storedId: string;

  beforeAll(async () => {
    const raised = await raiseDispute('pending', pdfBytes());
    transactionId = raised.transactionId;
    pendingId = raised.upload['evidenceId'];
    // A STORED row without bytes: these cases stop before the viewer, so they run without the Lambda images.
    storedId = adminRows(
      `with e as (
         insert into disputes.dispute_evidence (dispute_id, file_name, declared_content_type, declared_size_bytes,
                                                declared_sha256, s3_key, status, stored_at)
         select id, 'seeded-e2e.pdf', 'application/pdf', 10, repeat('a', 64), 'evidence/e2e/' || gen_random_uuid(), 'STORED', now()
           from disputes.dispute where dispute_id = '${raised.disputeId}'
         returning evidence_id)
       select json_agg(json_build_object('evidenceId', evidence_id)) from e;`,
      { raw: true },
    )[0]?.['evidenceId'];
  }, 60_000);

  it('a PENDING item is 409 EVIDENCE_NOT_STORED and writes no audit row', async () => {
    const reply = await download(transactionId, pendingId);
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'EVIDENCE_NOT_STORED' });
    expect(auditRows(pendingId)).toHaveLength(0);
  });

  it('the owning customer and a service are both 403', async () => {
    const service = await serviceToken('svc-notifier');
    expect((await download(transactionId, storedId, tokenA)).status).toBe(403);
    expect((await download(transactionId, storedId, service)).status).toBe(403);
    expect(auditRows(storedId)).toHaveLength(0);
  });

  describe('with the viewer stopped', () => {
    beforeAll(() => stopService('evidence-viewer'), 60_000);
    afterAll(() => startService('evidence-viewer'), 60_000);

    it('the download is 503 VIEWER_UNAVAILABLE and its audit row stands', async () => {
      const before = auditRows(storedId).length;
      const reply = await download(transactionId, storedId);
      expect(reply.status).toBe(503);
      expect(reply.body).toMatchObject({ code: 'VIEWER_UNAVAILABLE' });
      expect(auditRows(storedId)).toHaveLength(before + 1);
    });
  });

  // Last: its seeded views hold the cap for a few seconds.
  it('at the cap the request is 429 with Retry-After from the oldest counted view, and writes no row', async () => {
    // Seeded views leave the 10-minute window within seconds, so reruns are unaffected; the window itself is proven in disputes' tests.
    adminExec(`
      insert into disputes.evidence_view (evidence_id, dispute_id, agent_id, viewed_at)
      select e.id, e.dispute_id, '${agentIdE}', now() - interval '10 minutes' + interval '12 seconds'
        from disputes.dispute_evidence e, generate_series(1, ${RATE_CAP})
       where e.evidence_id = '${storedId}';`);
    const seeded = auditRows(storedId).length;

    const capped = await download(transactionId, storedId);
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ code: 'RATE_LIMITED' });
    const retryAfter = Number(capped.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(12);
    expect(auditRows(storedId)).toHaveLength(seeded);
  }, 60_000);
});
