import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseRequest, validationProblem } from '../src/request.ts';

describe('validationProblem', () => {
  it('keeps the path but never echoes unrecognized key names', () => {
    const parsed = parseRequest(z.object({ inner: z.strictObject({ a: z.string() }) }), {
      inner: { a: 'x', evil_key_123: 1 },
    });
    if (parsed.ok) throw new Error('expected a validation failure');
    const { detail } = validationProblem(parsed.error, 'cid-12345');
    expect(detail).toBe('inner: unknown field');
  });
});
