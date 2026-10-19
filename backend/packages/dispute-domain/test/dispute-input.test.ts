import { err, ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import { validateDisputeInput, type DisputeInput } from '../src/index.ts';

describe('validateDisputeInput', () => {
  const chars = (n: number, c = 'a'): string => c.repeat(n);

  const rows: ReadonlyArray<{ name: string; input: DisputeInput; expected: ReturnType<typeof validateDisputeInput> }> = [
    { name: 'valid input', input: { reasonCode: 'FRAUD', description: chars(10) }, expected: ok({ reasonCode: 'FRAUD', description: chars(10) }) },
    { name: 'unknown reason code', input: { reasonCode: 'CHANGED_MIND', description: chars(10) }, expected: err('INVALID_REASON') },
    { name: 'reason codes are case-sensitive', input: { reasonCode: 'fraud', description: chars(10) }, expected: err('INVALID_REASON') },
    { name: 'reason checked before description', input: { reasonCode: '', description: '' }, expected: err('INVALID_REASON') },
    { name: 'description of 9 chars', input: { reasonCode: 'OTHER', description: chars(9) }, expected: err('INVALID_DESCRIPTION') },
    { name: 'description of 2000 chars', input: { reasonCode: 'OTHER', description: chars(2000) }, expected: ok({ reasonCode: 'OTHER', description: chars(2000) }) },
    { name: 'description of 2001 chars', input: { reasonCode: 'OTHER', description: chars(2001) }, expected: err('INVALID_DESCRIPTION') },
    { name: '2000 astral chars count as 2000, matching the DB length()', input: { reasonCode: 'OTHER', description: chars(2000, '😀') }, expected: ok({ reasonCode: 'OTHER', description: chars(2000, '😀') }) },
  ];

  it.each(rows)('$name', ({ input, expected }) => {
    expect(validateDisputeInput(input)).toEqual(expected);
  });
});
