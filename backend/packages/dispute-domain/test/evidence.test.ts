import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_REJECTION_REASONS,
  EVIDENCE_SNIFF_BYTES,
  EVIDENCE_STATUSES,
  detectEvidenceType,
  type EvidenceContentType,
} from '../src/index.ts';

describe('evidence rule values (docs/02, docs/03)', () => {
  it.each<[string, unknown, unknown]>([
    ['content types', EVIDENCE_CONTENT_TYPES, ['application/pdf', 'image/jpeg', 'image/png']],
    ['statuses', EVIDENCE_STATUSES, ['PENDING', 'STORED', 'REJECTED', 'EXPIRED', 'ERASED']],
    ['rejection reasons', EVIDENCE_REJECTION_REASONS, ['MALWARE', 'TYPE_MISMATCH', 'CHECKSUM', 'SIZE', 'SCAN_FAILED']],
    ['sniff length covers the longest signature (PNG)', EVIDENCE_SNIFF_BYTES, 8],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });
});

const bytes = (...values: ReadonlyArray<number>): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

const PDF = ascii('%PDF-1.7\n');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

describe('detectEvidenceType', () => {
  it.each<[string, Uint8Array, EvidenceContentType | null]>([
    ['PDF', PDF, 'application/pdf'],
    ['PDF at exactly 5 bytes', ascii('%PDF-'), 'application/pdf'],
    ['JPEG (JFIF)', JPEG, 'image/jpeg'],
    ['JPEG (EXIF) at exactly 3 bytes', bytes(0xff, 0xd8, 0xff), 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['PNG followed by more data', bytes(...PNG, 0x00, 0x00, 0x00, 0x0d), 'image/png'],
    ['MZ executable head', bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00), null],
    ['MZ head with %PDF- later', bytes(0x4d, 0x5a, ...ascii('%PDF-1.7')), null],
    ["'%PDF-' not at offset 0", ascii(' %PDF-1.7'), null],
    ['truncated PDF head (4 bytes)', ascii('%PDF'), null],
    ['truncated JPEG head (2 bytes)', bytes(0xff, 0xd8), null],
    ['truncated PNG head (7 bytes)', PNG.subarray(0, 7), null],
    ['empty head', new Uint8Array(0), null],
    ['HTML', ascii('<!doctype html>'), null],
    ['GIF', ascii('GIF89a'), null],
  ])('%s', (_name, head, expected) => {
    expect(detectEvidenceType(head)).toBe(expected);
  });
});
