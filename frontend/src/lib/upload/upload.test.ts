import { describe, expect, it } from 'vitest';
import { createFakeXhr } from '../../../test/dispute-form/fakeXhr';
import { hexToBase64, sha256Hex } from './sha256';
import { uploadEvidence, type UploadInstruction } from './uploadEvidence';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const instructionFor = (file: Blob, overrides: Partial<UploadInstruction['headers']> = {}): UploadInstruction => ({
  evidenceId: '0192f0c1-0000-7000-8000-0000000000e1',
  method: 'PUT',
  url: 'https://quarantine.s3.eu-north-1.amazonaws.com/key?X-Amz-Signature=abc',
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Length': String(file.size),
    'x-amz-checksum-sha256': hexToBase64(ABC_SHA256),
    ...overrides,
  },
  expiresAt: '2026-10-19T10:10:00Z',
});

describe('sha256Hex', () => {
  it('returns the lower-case hex SHA-256 of the file bytes', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(ABC_SHA256);
  });

  it('base64-encodes the digest the way S3 expects in x-amz-checksum-sha256', () => {
    expect(hexToBase64(ABC_SHA256)).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

describe('uploadEvidence', () => {
  it('PUTs the file to the presigned URL with exactly the returned headers and no Authorization', async () => {
    const file = new Blob(['abc'], { type: 'application/pdf' });
    const instruction = instructionFor(file);
    const fake = createFakeXhr();
    const progress: number[] = [];

    const pending = uploadEvidence(instruction, file, (fraction) => progress.push(fraction), {
      createXhr: () => fake.xhr,
    });
    fake.progress(1, 2);
    fake.respond(200);

    expect(await pending).toEqual({ ok: true, value: undefined });
    expect(fake.method()).toBe('PUT');
    expect(fake.url()).toBe(instruction.url);
    expect(fake.headers()).toEqual({
      'Content-Type': 'application/pdf',
      'x-amz-checksum-sha256': instruction.headers['x-amz-checksum-sha256'],
    });
    expect(fake.body()).toBe(file);
    expect(progress).toEqual([0.5]);
  });

  it('refuses an instruction whose Content-Length does not match the file, without sending', async () => {
    const file = new Blob(['abc'], { type: 'application/pdf' });
    const fake = createFakeXhr();

    const result = await uploadEvidence(instructionFor(file, { 'Content-Length': '999' }), file, () => undefined, {
      createXhr: () => fake.xhr,
    });

    expect(result).toEqual({ ok: false, error: 'INVALID_INSTRUCTION' });
    expect(fake.method()).toBeNull();
  });

  it('reports an S3 rejection as a failed upload', async () => {
    const file = new Blob(['abc'], { type: 'application/pdf' });
    const fake = createFakeXhr();

    const pending = uploadEvidence(instructionFor(file), file, () => undefined, { createXhr: () => fake.xhr });
    fake.respond(403);

    expect(await pending).toEqual({ ok: false, error: 'REJECTED' });
  });
});
