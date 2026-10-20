import { describe, expect, it } from 'vitest';
import { erasureCutoff, isErasable, isSlotExpired, slotExpiryCutoff } from '../src/index.ts';

const at = (iso: string): Date => new Date(iso);

describe('slotExpiryCutoff / isSlotExpired (PENDING older than 24 h)', () => {
  it('cutoff is exactly 24 h before now', () => {
    expect(slotExpiryCutoff(at('2026-10-20T10:00:00.000Z'))).toEqual(at('2026-10-19T10:00:00.000Z'));
  });

  it.each<[string, string, string, boolean]>([
    ['exactly 24 h old', '2026-10-19T10:00:00.000Z', '2026-10-20T10:00:00.000Z', true],
    ['1 ms short of 24 h', '2026-10-19T10:00:00.000Z', '2026-10-20T09:59:59.999Z', false],
    ['older than 24 h', '2026-10-18T10:00:00.000Z', '2026-10-20T10:00:00.000Z', true],
    ['just created', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', false],
    ['across a month end', '2026-10-31T23:30:00.000Z', '2026-11-01T23:30:00.000Z', true],
    ['created in the future', '2026-10-21T10:00:00.000Z', '2026-10-20T10:00:00.000Z', false],
    ['invalid clock', '2026-10-01T10:00:00.000Z', 'invalid', false],
    ['invalid createdAt', 'invalid', '2026-10-20T10:00:00.000Z', false],
  ])('%s: expired %s', (_name, createdAt, now, expected) => {
    expect(isSlotExpired(at(createdAt), at(now))).toBe(expected);
  });
});

describe('erasureCutoff / isErasable (1 UTC calendar year after the terminal time)', () => {
  it.each<[string, string, string]>([
    ['ordinary date', '2026-06-15T08:30:15.250Z', '2025-06-15T08:30:15.250Z'],
    ['leap day clamps to Feb 28', '2028-02-29T12:00:00.000Z', '2027-02-28T12:00:00.000Z'],
    ['Feb 28 after a leap year', '2025-02-28T00:00:00.000Z', '2024-02-28T00:00:00.000Z'],
    ['Mar 1 after a leap year', '2025-03-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
    ['New Year instant', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  ])('%s', (_name, now, cutoff) => {
    expect(erasureCutoff(at(now))).toEqual(at(cutoff));
  });

  it.each<[string, string, string, boolean]>([
    ['exactly one year', '2025-06-15T08:00:00.000Z', '2026-06-15T08:00:00.000Z', true],
    ['1 ms short of one year', '2025-06-15T08:00:00.000Z', '2026-06-15T07:59:59.999Z', false],
    ['365 days but not a calendar year (leap span)', '2027-06-15T08:00:00.000Z', '2028-06-14T08:00:00.000Z', false],
    ['one calendar year across Feb 29 (366 days)', '2027-06-15T08:00:00.000Z', '2028-06-15T08:00:00.000Z', true],
    ['Feb-29 terminal: not on Feb 28 of the next year', '2024-02-29T10:00:00.000Z', '2025-02-28T23:59:59.999Z', false],
    ['Feb-29 terminal: eligible from Mar 1 00:00', '2024-02-29T10:00:00.000Z', '2025-03-01T00:00:00.000Z', true],
    ['Feb-28 terminal: eligible on Feb 28 of the leap year', '2027-02-28T12:00:00.000Z', '2028-02-28T12:00:00.000Z', true],
    ['Mar-1 terminal: not on the leap day', '2027-03-01T00:00:00.000Z', '2028-02-29T23:59:59.999Z', false],
    ['Mar-1 terminal: eligible on Mar 1', '2027-03-01T00:00:00.000Z', '2028-03-01T00:00:00.000Z', true],
    ['UTC, not local: 23:00Z terminal', '2025-12-31T23:00:00.000Z', '2026-12-31T22:59:59.999Z', false],
    ['invalid clock', '2020-01-01T00:00:00.000Z', 'invalid', false],
    ['invalid terminal time', 'invalid', '2026-06-15T08:00:00.000Z', false],
  ])('%s: erasable %s', (_name, terminalAt, now, expected) => {
    expect(isErasable(at(terminalAt), at(now))).toBe(expected);
  });
});
