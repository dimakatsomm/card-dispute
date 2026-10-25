import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bundle = readFileSync(new URL('../certs/rds-global-bundle.pem', import.meta.url), 'utf8');
const certs = (bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
  (pem) => new X509Certificate(pem),
);

describe('RDS CA bundle', () => {
  it('parses into currently valid CA certificates including the eu-north-1 roots', () => {
    expect(certs.length).toBeGreaterThan(0);
    expect(certs.every((c) => c.ca)).toBe(true);
    expect(certs.every((c) => new Date(c.validTo).getTime() > Date.now())).toBe(true);
    expect(certs.some((c) => c.subject.includes('CN=Amazon RDS eu-north-1 Root CA'))).toBe(true);
  });
});
