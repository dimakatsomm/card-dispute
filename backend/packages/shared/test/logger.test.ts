import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';

const capture = () => {
  const lines: Array<Record<string, unknown>> = [];
  const destination = { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) };
  return { lines, logger: createLogger({ destination }) };
};

describe('createLogger redaction', () => {
  it('redacts every sensitive key at top level and one level down, and keeps the rest', () => {
    const { lines, logger } = capture();
    const sensitive = {
      authorization: 'Bearer abc',
      token: 't',
      email: 'a@b.co',
      cellphoneNumber: '0821234567',
      name: 'Ada',
      surname: 'Lovelace',
      password: 'pw',
    };
    const redacted = Object.fromEntries(Object.keys(sensitive).map((k) => [k, '[Redacted]']));
    logger.info({ ...sensitive, user: sensitive, client: { secret: 'shh', id: 'svc-1' }, ok: 'visible' }, 'hello');

    expect(lines[0]).toMatchObject({
      ...redacted,
      user: redacted,
      client: { secret: '[Redacted]', id: 'svc-1' },
      ok: 'visible',
    });
    const text = JSON.stringify(lines[0]);
    for (const leaked of ['Bearer abc', 'a@b.co', '0821234567', 'Ada', 'Lovelace', 'shh']) {
      expect(text).not.toContain(leaked);
    }
  });
});
