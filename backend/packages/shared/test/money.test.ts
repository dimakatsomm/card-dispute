import { describe, expect, it } from 'vitest';
import { err, ok } from '../src/fp.ts';
import { addMoney, compareMoney, lteMoney } from '../src/money.ts';

describe('money', () => {
  it.each([
    ['0.10', '0.20', '0.30'],
    ['100.00', '0.01', '100.01'],
    ['1', '0.50', '1.50'],
    ['-5.00', '2.50', '-2.50'],
    ['-1.00', '1.00', '0.00'],
    ['0.05', '-0.10', '-0.05'],
    ['99999999999999999.99', '0.01', '100000000000000000.00'],
  ])('adds %s + %s = %s exactly', (a, b, sum) => {
    expect(addMoney(a, b)).toEqual(ok(sum));
  });

  it.each([
    ['100.00', '100.00', 0],
    ['0.30', '0.3', 0],
    ['2.00', '10.00', -1],
    ['-1.00', '-2.00', 1],
  ] as const)('compares %s with %s as %i numerically, not lexically', (a, b, expected) => {
    expect(compareMoney(a, b)).toEqual(ok(expected));
  });

  it('lteMoney is inclusive', () => {
    expect(lteMoney('100.00', '100.00')).toEqual(ok(true));
    expect(lteMoney('100.01', '100.00')).toEqual(ok(false));
  });

  it.each(['', '1.', '1e3', ' 1.00', '1.00\n', '1'.repeat(19), '1.12345'])('rejects malformed amount %j', (bad) => {
    expect(addMoney(bad, '1.00')).toEqual(err('INVALID_MONEY'));
    expect(compareMoney('1.00', bad)).toEqual(err('INVALID_MONEY'));
  });
});
