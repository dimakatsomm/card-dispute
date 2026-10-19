import { err, ok, type Result } from './fp.ts';

export type MoneyError = 'INVALID_MONEY';

type Scaled = { readonly units: bigint; readonly scale: number };
type Aligned = { readonly a: bigint; readonly b: bigint; readonly scale: number };

const DECIMAL = /^(-?)(\d{1,18})(?:\.(\d{1,4}))?$/;

const parse = (s: string): Result<Scaled, MoneyError> => {
  const m = DECIMAL.exec(s);
  if (!m) return err('INVALID_MONEY');
  const frac = m[3] ?? '';
  const units = BigInt(`${m[2]}${frac}`);
  return ok({ units: m[1] === '-' ? -units : units, scale: frac.length });
};

const align = (a: Scaled, b: Scaled): Aligned => {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
};

const format = (units: bigint, scale: number): string => {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const body = scale === 0 ? whole : `${whole}.${digits.slice(digits.length - scale)}`;
  return units < 0n ? `-${body}` : body;
};

const both = <T>(x: string, y: string, f: (v: Aligned) => T): Result<T, MoneyError> => {
  const a = parse(x);
  const b = parse(y);
  return a.ok && b.ok ? ok(f(align(a.value, b.value))) : err('INVALID_MONEY');
};

export const addMoney = (x: string, y: string): Result<string, MoneyError> =>
  both(x, y, (v) => format(v.a + v.b, v.scale));

export const compareMoney = (x: string, y: string): Result<-1 | 0 | 1, MoneyError> =>
  both(x, y, (v) => (v.a < v.b ? -1 : v.a > v.b ? 1 : 0));

export const lteMoney = (x: string, y: string): Result<boolean, MoneyError> =>
  both(x, y, (v) => v.a <= v.b);
