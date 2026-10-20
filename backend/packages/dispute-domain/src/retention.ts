export const PENDING_EVIDENCE_MAX_AGE_HOURS = 24;
export const RETENTION_YEARS = 1;

const MS_PER_HOUR = 3_600_000;

const daysInUtcMonth = (year: number, monthIndex: number): number => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

export const slotExpiryCutoff = (now: Date): Date => new Date(now.getTime() - PENDING_EVIDENCE_MAX_AGE_HOURS * MS_PER_HOUR);

// Clamps Feb 29 to Feb 28 like Postgres `- interval '1 year'`, so nothing is erased a day early.
export const erasureCutoff = (now: Date): Date => {
  const year = now.getUTCFullYear() - RETENTION_YEARS;
  const month = now.getUTCMonth();
  const day = Math.min(now.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(year, month, day, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()),
  );
};

// Written as a positive check so an invalid clock or timestamp (NaN) is never eligible.
const isAtOrBefore = (at: Date, cutoff: Date): boolean => at.getTime() <= cutoff.getTime();

export const isSlotExpired = (createdAt: Date, now: Date): boolean => isAtOrBefore(createdAt, slotExpiryCutoff(now));

export const isErasable = (terminalAt: Date, now: Date): boolean => isAtOrBefore(terminalAt, erasureCutoff(now));
