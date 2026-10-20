import { err, ok, type Result } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import type { EvidenceResult } from '../../src/core/decide.ts';
import {
  processEvidence,
  type DisputesError,
  type HeadResult,
  type IntakeDeps,
  type RecordOutcome,
  type SniffResult,
} from '../../src/use-cases/process-evidence.ts';
import { EXE_BYTES, PDF_BYTES, SHA_HEX, intakeKey, objectCreatedEvent, scanResultEvent } from '../fixtures.ts';

const BUCKET = 'quarantine';
const { key, transactionId, evidenceId } = intakeKey();
const S3_KEY = `evidence/0199f000-0000-7000-8000-000000000001/${evidenceId}`;
const ETAG = '"etag-1"';

type Call = readonly [string, ...unknown[]];

type FakeOptions = {
  readonly head?: HeadResult;
  readonly sniff?: SniffResult;
  readonly record?: (result: EvidenceResult) => Result<RecordOutcome, DisputesError>;
  readonly removeFailures?: number;
  readonly requireScan?: boolean;
};

const pdfHead: HeadResult = { kind: 'found', sizeBytes: 2048, sha256Hex: SHA_HEX, contentType: 'application/pdf', eTag: ETAG };

const echo = (result: EvidenceResult): Result<RecordOutcome, DisputesError> =>
  ok(result.result === 'STORED' ? { kind: 'recorded', status: 'STORED', s3Key: S3_KEY } : { kind: 'recorded', status: 'REJECTED' });

const fake = (options: FakeOptions = {}) => {
  const calls: Call[] = [];
  let removeFailures = options.removeFailures ?? 0;
  const deps: IntakeDeps = {
    quarantineBucket: BUCKET,
    requireScan: options.requireScan ?? true,
    quarantine: {
      head: async (k) => {
        calls.push(['head', k]);
        return options.head ?? pdfHead;
      },
      sniff: async (k, bytes, eTag) => {
        calls.push(['sniff', k, bytes, eTag]);
        return options.sniff ?? { kind: 'bytes', head: PDF_BYTES.slice(0, bytes) };
      },
      promote: async (k, target) => {
        calls.push(['promote', k, target]);
      },
      remove: async (k) => {
        calls.push(['remove', k]);
        if (removeFailures > 0) {
          removeFailures -= 1;
          throw new Error('S3 DeleteObject failed');
        }
      },
    },
    recordResult: async (ref, result, correlationId) => {
      calls.push(['record', ref, result, correlationId]);
      return (options.record ?? echo)(result);
    },
    notScanned: () => calls.push(['metric', 'EvidenceNotScanned']),
    resultConflict: () => calls.push(['metric', 'EvidenceResultConflict']),
    newId: () => 'generated-correlation-id',
    log: {
      info: () => undefined,
      warn: (_obj, msg) => calls.push(['warn', msg]),
      error: (obj) => calls.push(['error', obj]),
    },
  };
  return { deps, calls, names: () => calls.map(([name]) => name) };
};

const clean = () => scanResultEvent({ bucket: BUCKET, key, eTag: 'etag-1' });

describe('processEvidence: order of effects', () => {
  it('clean PDF: HeadObject, ranged GET, PUT STORED with facts and the event id as correlation id, copy to s3Key, delete', async () => {
    const { deps, calls, names } = fake();
    const event = clean();
    expect(await processEvidence(deps)(event)).toEqual(ok('PROMOTED'));
    expect(names()).toEqual(['head', 'sniff', 'record', 'promote', 'remove']);
    expect(calls[1]).toEqual(['sniff', key, 8, ETAG]);
    expect(calls[2]).toEqual([
      'record',
      { transactionId, evidenceId },
      { result: 'STORED', sha256: SHA_HEX, sizeBytes: 2048, contentType: 'application/pdf' },
      event.id,
    ]);
    expect(calls[3]).toEqual(['promote', key, { s3Key: S3_KEY, eTag: ETAG, contentType: 'application/pdf' }]);
  });

  it('disputes answering REJECTED to a claimed STORED: delete only, nothing copied', async () => {
    const { deps, names } = fake({ record: () => ok({ kind: 'recorded', status: 'REJECTED' }) });
    expect(await processEvidence(deps)(clean())).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['head', 'sniff', 'record', 'remove']);
  });

  it('renamed exe declared as PDF: TYPE_MISMATCH, never copied', async () => {
    const { deps, calls, names } = fake({ sniff: { kind: 'bytes', head: EXE_BYTES.slice(0, 8) } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['head', 'sniff', 'record', 'remove']);
    expect(calls[2]?.[2]).toMatchObject({ result: 'REJECTED', reason: 'TYPE_MISMATCH' });
  });

  it('THREATS_FOUND: PUT REJECTED MALWARE without facts, no read of the object, delete', async () => {
    const { deps, calls, names } = fake();
    expect(await processEvidence(deps)(scanResultEvent({ bucket: BUCKET, key }, 'THREATS_FOUND'))).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['record', 'remove']);
    expect(calls[0]?.[2]).toEqual({ result: 'REJECTED', reason: 'MALWARE' });
  });

  it.each(['UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'] as const)('%s: PUT REJECTED SCAN_FAILED without facts, delete', async (status) => {
    const { deps, calls, names } = fake();
    expect(await processEvidence(deps)(scanResultEvent({ bucket: BUCKET, key }, status))).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['record', 'remove']);
    expect(calls[0]?.[2]).toEqual({ result: 'REJECTED', reason: 'SCAN_FAILED' });
  });

  it('HeadObject denied: PUT REJECTED SCAN_FAILED without facts', async () => {
    const { deps, calls, names } = fake({ head: { kind: 'denied' } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['head', 'record', 'remove']);
    expect(calls[1]?.[2]).toEqual({ result: 'REJECTED', reason: 'SCAN_FAILED' });
  });

  it('an empty object is judged without a ranged GET', async () => {
    const { deps, names } = fake({ head: { ...pdfHead, sizeBytes: 0 } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['head', 'record', 'remove']);
  });
});

describe('processEvidence: retries and duplicates', () => {
  it('copy done but delete failed: the invocation throws, the retry completes', async () => {
    const { deps, names } = fake({ removeFailures: 1 });
    const event = clean();
    await expect(processEvidence(deps)(event)).rejects.toThrow('DeleteObject');
    expect(await processEvidence(deps)(event)).toEqual(ok('PROMOTED'));
    expect(names()).toEqual(['head', 'sniff', 'record', 'promote', 'remove', 'head', 'sniff', 'record', 'promote', 'remove']);
  });

  it('a duplicate after the object is gone (HeadObject 404) is a success no-op', async () => {
    const { deps, names } = fake({ head: { kind: 'missing' } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('ALREADY_PROCESSED'));
    expect(names()).toEqual(['head']);
  });

  it('object deleted between HeadObject and the ranged GET is a success no-op', async () => {
    const { deps, names } = fake({ sniff: { kind: 'missing' } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('ALREADY_PROCESSED'));
    expect(names()).toEqual(['head', 'sniff']);
  });

  it('a scan event for a replaced object (ETag differs) is a no-op; the new object has its own scan', async () => {
    const { deps, names } = fake({ head: { ...pdfHead, eTag: '"etag-2"' } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('SUPERSEDED'));
    expect(names()).toEqual(['head']);
  });

  it.each(['UNAVAILABLE', 'REFUSED', 'BAD_RESPONSE'] as const)('disputes %s: error, object kept', async (error) => {
    const { deps, names } = fake({ record: () => err(error) });
    expect(await processEvidence(deps)(clean())).toEqual(err(`DISPUTES_${error}`));
    expect(names()).toEqual(['head', 'sniff', 'record']);
  });

  it('disputes 404: error, object kept', async () => {
    const { deps, names } = fake({ record: () => err('NOT_FOUND') });
    expect(await processEvidence(deps)(clean())).toEqual(err('DISPUTES_NOT_FOUND'));
    expect(names()).toEqual(['head', 'sniff', 'record']);
  });

  it.each([
    ['EVIDENCE_CLOSED', ok({ kind: 'closed' } as const), ok('CLOSED'), ['head', 'sniff', 'record', 'remove', 'warn']],
    ['RESULT_CONFLICT', err('RESULT_CONFLICT' as const), err('DISPUTES_RESULT_CONFLICT'), ['head', 'sniff', 'record', 'metric', 'error']],
    ['unknown 409', err('UNKNOWN_CONFLICT' as const), err('DISPUTES_UNKNOWN_CONFLICT'), ['head', 'sniff', 'record']],
  ])('disputes 409 %s', async (_name, answer, expected, effects) => {
    const { deps, calls, names } = fake({ record: () => answer });
    expect(await processEvidence(deps)(clean())).toEqual(expected);
    expect(names()).toEqual(effects);
    const logged = calls.find(([name]) => name === 'error')?.[1];
    if (logged) expect(Object.keys(logged as object).sort()).toEqual(['claimed', 'correlationId', 'evidenceId', 'transactionId']);
  });

  it('scanned CLEAN but HeadObject has no ETag: REJECTED SCAN_FAILED without facts, no ranged GET', async () => {
    const { deps, calls, names } = fake({ head: { ...pdfHead, eTag: null } });
    expect(await processEvidence(deps)(clean())).toEqual(ok('REJECTED'));
    expect(names()).toEqual(['head', 'record', 'remove']);
    expect(calls[1]?.[2]).toEqual({ result: 'REJECTED', reason: 'SCAN_FAILED' });
  });

  it('disputes answering STORED to a claimed REJECTED: error, nothing copied or deleted', async () => {
    const { deps, names } = fake({ record: () => ok({ kind: 'recorded', status: 'STORED', s3Key: S3_KEY }) });
    expect(await processEvidence(deps)(scanResultEvent({ bucket: BUCKET, key }, 'THREATS_FOUND'))).toEqual(
      err('INCONSISTENT_RESPONSE'),
    );
    expect(names()).toEqual(['record']);
  });
});

describe('processEvidence: invalid triggers call nothing', () => {
  it.each([
    ['garbage', { nope: true }, 'INVALID_EVENT'],
    ['another bucket', scanResultEvent({ bucket: 'cd-evidence', key }), 'WRONG_BUCKET'],
    ['bad key', scanResultEvent({ bucket: BUCKET, key: 'intake/x/y' }), 'INVALID_KEY'],
  ] as const)('%s → %s', async (_name, event, error) => {
    const { deps, calls } = fake();
    expect(await processEvidence(deps)(event)).toEqual(err(error));
    expect(calls).toEqual([]);
  });
});

describe('processEvidence: EVIDENCE_REQUIRE_SCAN', () => {
  it('default true: Object Created is refused and nothing is called or emitted', async () => {
    const { deps, calls } = fake();
    expect(await processEvidence(deps)(objectCreatedEvent({ bucket: BUCKET, key }))).toEqual(err('SCAN_REQUIRED'));
    expect(calls).toEqual([]);
  });

  it('false: Object Created skips the verdict, emits EvidenceNotScanned + warn, and still checks the facts', async () => {
    const { deps, names } = fake({ requireScan: false });
    expect(await processEvidence(deps)(objectCreatedEvent({ bucket: BUCKET, key, eTag: 'etag-1' }))).toEqual(ok('PROMOTED'));
    expect(names()).toEqual(['metric', 'warn', 'head', 'sniff', 'record', 'promote', 'remove']);
  });

  it('false: an Object Created event and HeadObject without ETags are still judged on the facts', async () => {
    const created = objectCreatedEvent({ bucket: BUCKET, key });
    const event = { ...created, detail: { ...created.detail, object: { key } } };
    const { deps, names } = fake({ requireScan: false, head: { ...pdfHead, eTag: null } });
    expect(await processEvidence(deps)(event)).toEqual(ok('PROMOTED'));
    expect(names()).toEqual(['metric', 'warn', 'head', 'sniff', 'record', 'promote', 'remove']);
  });

  it('false: an exe is still TYPE_MISMATCH', async () => {
    const { deps, names } = fake({ requireScan: false, sniff: { kind: 'bytes', head: EXE_BYTES } });
    expect(await processEvidence(deps)(objectCreatedEvent({ bucket: BUCKET, key, eTag: 'etag-1' }))).toEqual(ok('REJECTED'));
    expect(names()).not.toContain('promote');
  });
});
