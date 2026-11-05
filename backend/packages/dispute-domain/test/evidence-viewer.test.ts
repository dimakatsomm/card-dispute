import { describe, expect, it } from 'vitest';
import {
  evidenceDownloadFileName,
  evidenceObjectKey,
  evidenceViewRequestSchema,
  evidenceViewResponseSchema,
} from '../src/index.ts';

const disputeId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const valid = { disputeId, evidenceId, contentType: 'image/png', correlationId: 'corr-1234' };

describe('evidence viewer contract', () => {
  it('builds the evidence key and a generated file name', () => {
    expect(evidenceObjectKey(disputeId, evidenceId)).toBe(`evidence/${disputeId}/${evidenceId}`);
    expect(evidenceDownloadFileName(evidenceId, 'application/pdf')).toBe(`${evidenceId}.pdf`);
    expect(evidenceDownloadFileName(evidenceId, 'image/jpeg')).toBe(`${evidenceId}.jpg`);
    expect(evidenceDownloadFileName(evidenceId, 'image/png')).toBe(`${evidenceId}.png`);
  });

  it('accepts a valid request', () => {
    expect(evidenceViewRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['a key-like dispute id', { ...valid, disputeId: '../x' }],
    ['a key-like evidence id', { ...valid, evidenceId: `${evidenceId}/../y` }],
    ['an unsupported type', { ...valid, contentType: 'text/html' }],
    ['a bad correlation id', { ...valid, correlationId: 'a b' }],
    ['an s3 key smuggled in', { ...valid, s3Key: 'evidence/x/y' }],
    ['a missing field', { disputeId, evidenceId, contentType: 'image/png' }],
  ])('rejects %s', (_, input) => {
    expect(evidenceViewRequestSchema.safeParse(input).success).toBe(false);
  });

  it('accepts only an http(s) url and an offset timestamp in the response', () => {
    const at = '2026-11-05T10:00:00Z';
    expect(evidenceViewResponseSchema.safeParse({ url: 'https://s3.example/x?sig=1', expiresAt: at }).success).toBe(true);
    expect(evidenceViewResponseSchema.safeParse({ url: 'javascript:alert(1)', expiresAt: at }).success).toBe(false);
    expect(evidenceViewResponseSchema.safeParse({ url: 'https://s3.example/x', expiresAt: 'soon' }).success).toBe(false);
  });
});
