import { describe, expect, it } from 'vitest';
import { assertNever, err, flatMap, map, ok } from '../src/fp.ts';

describe('fp', () => {
  it('map transforms ok and passes err through untouched', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(map(err('E'), (n: number) => n * 2)).toEqual(err('E'));
  });

  it('flatMap chains ok and short-circuits on the first err', () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('ODD' as const));
    expect(flatMap(ok(4), half)).toEqual(ok(2));
    expect(flatMap(ok(3), half)).toEqual(err('ODD'));
    expect(flatMap(err('FIRST' as const), half)).toEqual(err('FIRST'));
  });

  it('assertNever throws naming the unexpected value', () => {
    expect(() => assertNever('X' as never)).toThrow('Unexpected value: "X"');
  });
});
