import { err, ok, type Result } from '@cd/shared/fp';

export type CursorError = 'INVALID_CURSOR';

export type CursorPosition = { readonly updatedAt: string; readonly disputeId: string };

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (position: CursorPosition): string =>
  Buffer.from(JSON.stringify([position.updatedAt, position.disputeId])).toString('base64url');

// Postgres has no year 0 and rejects dates Date.parse silently rolls over (Feb 30), so demand an exact round-trip.
const isStorableInstant = (at: string): boolean => {
  const ms = Date.parse(at);
  return !at.startsWith('0000') && !Number.isNaN(ms) && new Date(ms).toISOString() === `${at.slice(0, 23)}Z`;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const decodeCursor = (cursor: string): Result<CursorPosition, CursorError> => {
  const value = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Array.isArray(value) || value.length !== 2) return err('INVALID_CURSOR');
  const [updatedAt, disputeId] = value as readonly unknown[];
  return typeof updatedAt === 'string' &&
    typeof disputeId === 'string' &&
    AT.test(updatedAt) &&
    ID.test(disputeId) &&
    isStorableInstant(updatedAt)
    ? ok({ updatedAt, disputeId })
    : err('INVALID_CURSOR');
};
