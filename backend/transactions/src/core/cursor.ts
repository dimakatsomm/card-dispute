import { err, ok, type Result } from '@cd/shared/fp';
import type { CursorPosition, Transaction } from './transaction.ts';

export type CursorError = 'INVALID_CURSOR';

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (position: CursorPosition): string =>
  Buffer.from(JSON.stringify([position.transactionAt, position.transactionId])).toString('base64url');

// Postgres has no year 0 and rejects dates Date.parse silently rolls over (Feb 30), so demand an exact round-trip.
const isStorableInstant = (at: string): boolean => {
  const ms = Date.parse(at);
  return !at.startsWith('0000') && !Number.isNaN(ms) && new Date(ms).toISOString() === `${at.slice(0, 23)}Z`;
};

const parseJson =(text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const decodeCursor = (cursor: string): Result<CursorPosition, CursorError> => {
  const value = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Array.isArray(value) || value.length !== 2) return err('INVALID_CURSOR');
  const [transactionAt, transactionId] = value as readonly unknown[];
  return typeof transactionAt === 'string' &&
    typeof transactionId === 'string' &&
    AT.test(transactionAt) &&
    ID.test(transactionId) &&
    isStorableInstant(transactionAt)
    ? ok({ transactionAt, transactionId })
    : err('INVALID_CURSOR');
};

export type Page<T> = { readonly items: ReadonlyArray<T>; readonly nextCursor: string | null };

// The repository is asked for limit + 1 rows; the extra row only signals that another page exists.
export const toPage = (rows: ReadonlyArray<Transaction>, limit: number): Page<Transaction> => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ transactionAt: last.transactionAt, transactionId: last.transactionId })
        : null,
  };
};
