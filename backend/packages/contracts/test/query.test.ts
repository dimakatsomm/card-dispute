import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { queryOf } from '../src/query.ts';

const list = queryOf(
  z.object({
    status: z.array(z.enum(['SUBMITTED', 'WITHDRAWN'])).optional(),
    ids: z.array(z.string()).optional(),
    includeClosed: z.boolean().optional(),
    limit: z.int().gte(1).lte(100).optional().default(25),
  }),
  { csv: ['ids'] },
);

describe('queryOf', () => {
  it('keeps the default limit', () => {
    expect(list.parse({})).toEqual({ limit: 25 });
  });

  it('coerces numeric and boolean strings', () => {
    expect(list.parse({ limit: '10', includeClosed: 'true' })).toEqual({ limit: 10, includeClosed: true });
  });

  it.each(['abc', '1000', '0'])('rejects limit %s', (limit) => {
    expect(list.safeParse({ limit }).success).toBe(false);
  });

  it('wraps a single value into an array', () => {
    expect(list.parse({ status: 'SUBMITTED' }).status).toEqual(['SUBMITTED']);
  });

  it('splits only the named csv fields', () => {
    expect(list.parse({ ids: 'a,b' }).ids).toEqual(['a', 'b']);
    expect(list.safeParse({ status: 'SUBMITTED,WITHDRAWN' }).success).toBe(false);
  });

  it('still rejects unknown keys of a strict schema', () => {
    const strict = queryOf(z.strictObject({ limit: z.int().optional() }));
    expect(strict.safeParse({ limit: '1', extra: 'x' }).success).toBe(false);
  });
});
