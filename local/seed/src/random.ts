export type Rng = (...keys: ReadonlyArray<string | number>) => number;

const fnv1a = (s: string): number =>
  [...s].reduce((h, c) => Math.imul(h ^ (c.codePointAt(0) ?? 0), 0x01000193), 0x811c9dc5);

// murmur3 finaliser: FNV alone leaves the low bits poorly mixed for short keys.
const fmix32 = (input: number): number => {
  const a = Math.imul(input ^ (input >>> 16), 0x85ebca6b);
  const b = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (b ^ (b >>> 16)) >>> 0;
};

const hash32 = (s: string): number => fmix32(fnv1a(s));

// Counter-based: each value is a pure function of (seed, keys), so adding a row never shifts the others.
export const createRng =
  (seed: number): Rng =>
  (...keys) =>
    hash32(`${seed}|${keys.join('|')}`) / 2 ** 32;

export const intBetween = (r: number, min: number, max: number): number => min + Math.floor(r * (max - min + 1));

export const pick = <T>(items: ReadonlyArray<T>, r: number): T => {
  const item = items[Math.floor(r * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
};

const hex8 = (n: number): string => n.toString(16).padStart(8, '0');

// Name-based (RFC 9562 v8 layout) so ids are stable across runs and seeds: the ON CONFLICT key for idempotency.
export const stableUuid = (name: string): string => {
  const hex = [0, 1, 2, 3].map((i) => hex8(hash32(`cd-seed:${name}#${i}`))).join('');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
