import { MAX_EVIDENCE_BYTES } from '@cd/dispute-domain';
import { describe, expect, it } from 'vitest';
import { decide, type DecideInput, type EvidenceResult, type ObservedFacts } from '../../src/core/decide.ts';
import { SHA_HEX } from '../fixtures.ts';

const pdf: ObservedFacts = { sizeBytes: 2048, sha256Hex: SHA_HEX, contentType: 'application/pdf', detectedType: 'application/pdf' };

describe('decide', () => {
  const rows: ReadonlyArray<readonly [string, DecideInput, EvidenceResult]> = [
    [
      'clean PDF with matching facts is STORED',
      { verdict: 'CLEAN', facts: pdf },
      { result: 'STORED', sha256: SHA_HEX, sizeBytes: 2048, contentType: 'application/pdf' },
    ],
    [
      'not-scanned (fallback) with matching facts is STORED',
      { verdict: 'NOT_SCANNED', facts: { ...pdf, contentType: 'image/png', detectedType: 'image/png' } },
      { result: 'STORED', sha256: SHA_HEX, sizeBytes: 2048, contentType: 'image/png' },
    ],
    ['THREATS_FOUND is MALWARE without facts', { verdict: 'MALWARE' }, { result: 'REJECTED', reason: 'MALWARE' }],
    ['a failed or skipped scan is SCAN_FAILED without facts', { verdict: 'SCAN_FAILED' }, { result: 'REJECTED', reason: 'SCAN_FAILED' }],
    [
      'clean but HeadObject denied is SCAN_FAILED without facts',
      { verdict: 'CLEAN', facts: 'UNOBSERVABLE' },
      { result: 'REJECTED', reason: 'SCAN_FAILED' },
    ],
    [
      'renamed exe declared as PDF is TYPE_MISMATCH',
      { verdict: 'CLEAN', facts: { ...pdf, detectedType: null } },
      { result: 'REJECTED', reason: 'TYPE_MISMATCH', sha256: SHA_HEX, sizeBytes: 2048, contentType: 'application/pdf' },
    ],
    [
      'PNG bytes declared as PDF is TYPE_MISMATCH',
      { verdict: 'CLEAN', facts: { ...pdf, detectedType: 'image/png' } },
      { result: 'REJECTED', reason: 'TYPE_MISMATCH', sha256: SHA_HEX, sizeBytes: 2048, contentType: 'application/pdf' },
    ],
    [
      'missing Content-Type is TYPE_MISMATCH',
      { verdict: 'CLEAN', facts: { ...pdf, contentType: null } },
      { result: 'REJECTED', reason: 'TYPE_MISMATCH', sha256: SHA_HEX, sizeBytes: 2048 },
    ],
    [
      'exactly MAX_EVIDENCE_BYTES is STORED',
      { verdict: 'CLEAN', facts: { ...pdf, sizeBytes: MAX_EVIDENCE_BYTES } },
      { result: 'STORED', sha256: SHA_HEX, sizeBytes: MAX_EVIDENCE_BYTES, contentType: 'application/pdf' },
    ],
    [
      'one byte over MAX_EVIDENCE_BYTES is SIZE',
      { verdict: 'CLEAN', facts: { ...pdf, sizeBytes: MAX_EVIDENCE_BYTES + 1 } },
      { result: 'REJECTED', reason: 'SIZE', sha256: SHA_HEX, sizeBytes: MAX_EVIDENCE_BYTES + 1, contentType: 'application/pdf' },
    ],
    [
      'missing checksum is CHECKSUM',
      { verdict: 'CLEAN', facts: { ...pdf, sha256Hex: null } },
      { result: 'REJECTED', reason: 'CHECKSUM', sizeBytes: 2048, contentType: 'application/pdf' },
    ],
    [
      'empty object is TYPE_MISMATCH and reports no size',
      { verdict: 'CLEAN', facts: { ...pdf, sizeBytes: 0, detectedType: null } },
      { result: 'REJECTED', reason: 'TYPE_MISMATCH', sha256: SHA_HEX, contentType: 'application/pdf' },
    ],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    expect(decide(input)).toEqual(expected);
  });
});
