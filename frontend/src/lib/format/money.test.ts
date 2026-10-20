import { describe, expect, it } from 'vitest';
import { formatMoney } from './money';

describe('formatMoney', () => {
  it.each([
    ['a malformed currency code', '125.50', 'RANDS', 'RANDS 125.50'],
    ['a non-decimal amount', 'abc', 'ZAR', 'ZAR abc'],
  ])('falls back to the raw values for %s instead of throwing', (_, amount, currency, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected);
  });

  it('keeps every digit of a decimal string', () => {
    expect(formatMoney('12345678901234.57', 'ZAR')).toMatch(/12.345.678.901.234,57/);
  });
});
