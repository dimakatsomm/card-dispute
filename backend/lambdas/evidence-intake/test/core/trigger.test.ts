import { err } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import { parseTrigger, type TriggerError, type Verdict } from '../../src/core/trigger.ts';
import { driverScanEvent, intakeKey, objectCreatedEvent, scanResultEvent, type ScanResultStatus, type ScanStatus } from '../fixtures.ts';

const BUCKET = 'cd-evidence-quarantine';
const { key, transactionId, evidenceId } = intakeKey();
const at = { bucket: BUCKET, key };
const required = { quarantineBucket: BUCKET, requireScan: true };

describe('parseTrigger: verdict comes from the event', () => {
  const rows: ReadonlyArray<readonly [ScanResultStatus, ScanStatus, Verdict]> = [
    ['NO_THREATS_FOUND', 'COMPLETED', 'CLEAN'],
    ['THREATS_FOUND', 'COMPLETED', 'MALWARE'],
    ['UNSUPPORTED', 'SKIPPED', 'SCAN_FAILED'],
    ['ACCESS_DENIED', 'SKIPPED', 'SCAN_FAILED'],
    ['FAILED', 'FAILED', 'SCAN_FAILED'],
    ['NO_THREATS_FOUND', 'SKIPPED', 'SCAN_FAILED'],
    ['NO_THREATS_FOUND', 'FAILED', 'SCAN_FAILED'],
  ];

  it.each(rows)('%s with scanStatus %s gives %s', (resultStatus, scanStatus, verdict) => {
    const parsed = parseTrigger(scanResultEvent(at, resultStatus, scanStatus), required);
    expect(parsed).toMatchObject({ ok: true, value: { verdict, key, transactionId, evidenceId } });
  });

  it('accepts the local scan stub shape (null versionId, no statusReasons) and strips ETag quotes', () => {
    const parsed = parseTrigger(driverScanEvent({ ...at, eTag: '"abc123"' }, 'NO_THREATS_FOUND'), required);
    expect(parsed).toMatchObject({ ok: true, value: { verdict: 'CLEAN', eTag: 'abc123' } });
  });
});

type ScanEvent = ReturnType<typeof scanResultEvent>;

const withETag = (event: ScanEvent, eTag: string | null) => ({
  ...event,
  detail: { ...event.detail, s3ObjectDetails: { ...event.detail.s3ObjectDetails, eTag } },
});

const withoutETag = (event: ScanEvent) => {
  const details = Object.fromEntries(Object.entries(event.detail.s3ObjectDetails).filter(([name]) => name !== 'eTag'));
  return { ...event, detail: { ...event.detail, s3ObjectDetails: details } };
};

describe('parseTrigger: rejected triggers', () => {
  const scan = scanResultEvent(at);
  const rows: ReadonlyArray<readonly [string, unknown, TriggerError]> = [
    ['garbage', { hello: 'world' }, 'INVALID_EVENT'],
    ['null', null, 'INVALID_EVENT'],
    ['other GuardDuty detail-type', { ...scan, 'detail-type': 'GuardDuty Malware Protection Post Scan Action Failed' }, 'INVALID_EVENT'],
    ['unknown scan result status', { ...scan, detail: { ...scan.detail, scanResultDetails: { scanResultStatus: 'MAYBE' } } }, 'INVALID_EVENT'],
    ['another bucket', scanResultEvent({ bucket: 'cd-evidence', key }), 'WRONG_BUCKET'],
    ['key outside intake/', scanResultEvent({ bucket: BUCKET, key: `evidence/${transactionId}/${evidenceId}` }), 'INVALID_KEY'],
    ['non-uuid segments', scanResultEvent({ bucket: BUCKET, key: 'intake/abc/receipt.pdf' }), 'INVALID_KEY'],
    ['extra path segment', scanResultEvent({ bucket: BUCKET, key: `${key}/x` }), 'INVALID_KEY'],
    ['traversal', scanResultEvent({ bucket: BUCKET, key: `intake/${transactionId}/../${evidenceId}` }), 'INVALID_KEY'],
    ['Object Created while a scan is required', objectCreatedEvent(at), 'SCAN_REQUIRED'],
    ['scanned CLEAN without an eTag', withoutETag(scanResultEvent(at)), 'INVALID_EVENT'],
    ['scanned CLEAN with a null eTag', withETag(scanResultEvent(at), null), 'INVALID_EVENT'],
    ['scanned CLEAN with an empty eTag', withETag(scanResultEvent(at), ''), 'INVALID_EVENT'],
    ['scanned THREATS_FOUND without an eTag', withoutETag(scanResultEvent(at, 'THREATS_FOUND')), 'INVALID_EVENT'],
    ['local stub event without an eTag', driverScanEvent(at, 'NO_THREATS_FOUND'), 'INVALID_EVENT'],
  ];

  it.each(rows)('%s → %s', (_name, event, error) => {
    expect(parseTrigger(event, required)).toEqual(err(error));
  });
});

describe('parseTrigger: EVIDENCE_REQUIRE_SCAN=false', () => {
  const optional = { quarantineBucket: BUCKET, requireScan: false };

  it('accepts Object Created as NOT_SCANNED', () => {
    expect(parseTrigger(objectCreatedEvent(at), optional)).toMatchObject({ ok: true, value: { verdict: 'NOT_SCANNED', evidenceId } });
  });

  it('still honours a scan verdict', () => {
    expect(parseTrigger(scanResultEvent(at, 'THREATS_FOUND'), optional)).toMatchObject({ ok: true, value: { verdict: 'MALWARE' } });
  });

  it('accepts Object Created without an etag', () => {
    const created = objectCreatedEvent(at);
    const event = { ...created, detail: { ...created.detail, object: { key } } };
    expect(parseTrigger(event, optional)).toMatchObject({ ok: true, value: { verdict: 'NOT_SCANNED', eTag: null } });
  });

  it('still checks bucket and key on Object Created', () => {
    expect(parseTrigger(objectCreatedEvent({ bucket: 'elsewhere', key }), optional)).toEqual(err('WRONG_BUCKET'));
  });
});
