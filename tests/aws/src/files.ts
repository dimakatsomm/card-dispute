import { createHash, randomUUID } from 'node:crypto';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const sha256Base64 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('base64');

export const cleanPdf = (): Uint8Array =>
  text(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%run ${randomUUID()}\n%%EOF\n`,
  );

// Split so antivirus scanners do not flag this source file.
export const eicar = (): Uint8Array =>
  text(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join(''));

export const renamedExe = (): Uint8Array =>
  text(`MZ\x90\x00 This program cannot be run in DOS mode. ${randomUUID()} ${'x'.repeat(64)}`);

export type Declared = { readonly fileName: string; readonly bytes: Uint8Array };

export const declare = ({ fileName, bytes }: Declared) => ({
  fileName,
  contentType: 'application/pdf',
  sizeBytes: bytes.length,
  sha256: sha256Hex(bytes),
});
