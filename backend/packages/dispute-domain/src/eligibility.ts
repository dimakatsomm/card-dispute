import { err, ok, type Result } from '@cd/shared/fp';
import type { DisputeStatus } from './state-machine.ts';

export const DISPUTE_WINDOW_DAYS = 120;

export const TRANSACTION_TYPES = Object.freeze(['PURCHASE', 'REFUND', 'ATM_WITHDRAWAL', 'FEE'] as const);
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const DISPUTABLE_TRANSACTION_TYPES = Object.freeze([
  'PURCHASE',
  'ATM_WITHDRAWAL',
  'FEE',
] as const satisfies ReadonlyArray<TransactionType>);

export const TRANSACTION_STATUSES = Object.freeze(['PENDING', 'POSTED', 'DECLINED', 'REVERSED'] as const);
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const CARD_STATUSES = Object.freeze(['ACTIVE', 'BLOCKED', 'CANCELLED'] as const);
export type CardStatus = (typeof CARD_STATUSES)[number];

export type EligibilityTransaction = {
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  readonly postedAt: Date | null;
};

export type ExpiringCard = {
  readonly expiryMonth: number;
  readonly expiryYear: number;
};

export type EligibilityCard = ExpiringCard & {
  readonly status: CardStatus;
};

export type ExistingDispute = {
  readonly status: DisputeStatus;
};

export type EligibilityReason =
  | 'ALREADY_DISPUTED'
  | 'CARD_EXPIRED'
  | 'TXN_NOT_POSTED'
  | 'TXN_TYPE_NOT_DISPUTABLE'
  | 'OUTSIDE_WINDOW';

const MS_PER_DAY = 86_400_000;

// Matches the card.expiry_year CHECK in docs/03.
const MIN_EXPIRY_YEAR = 2000;
const MAX_EXPIRY_YEAR = 2100;

const isValidDate = (d: Date): boolean => !Number.isNaN(d.getTime());

const isIntegerIn = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;

const isValidExpiry = (card: ExpiringCard): boolean =>
  isIntegerIn(card.expiryMonth, 1, 12) && isIntegerIn(card.expiryYear, MIN_EXPIRY_YEAR, MAX_EXPIRY_YEAR);

const utcMidnight = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const wholeUtcDaysBetween = (from: Date, to: Date): number => (utcMidnight(to) - utcMidnight(from)) / MS_PER_DAY;

// Written as a positive check so NaN (invalid clock) and a future postedAt both fall outside the window.
const isWithinWindow =(postedAt: Date, now: Date): boolean =>
  postedAt.getTime() <= now.getTime() && wholeUtcDaysBetween(postedAt, now) <= DISPUTE_WINDOW_DAYS;

const isDisputableType = (type: TransactionType): boolean =>
  (DISPUTABLE_TRANSACTION_TYPES as ReadonlyArray<TransactionType>).includes(type);

// Fails closed: an unparseable clock or expiry counts as expired. Date.UTC months are 0-based, so the
// 1-based expiryMonth yields the first instant of the following month.
export const isCardExpired = (card: ExpiringCard, now: Date): boolean =>
  !isValidDate(now) || !isValidExpiry(card) || now.getTime() >= Date.UTC(card.expiryYear, card.expiryMonth, 1);

export const evaluateTransactionEligibility = (
  txn: EligibilityTransaction,
  card: EligibilityCard,
  existingDispute: ExistingDispute | null,
  now: Date,
): Result<true, EligibilityReason> => {
  if (existingDispute !== null) return err('ALREADY_DISPUTED');
  if (isCardExpired(card, now)) return err('CARD_EXPIRED');
  if (txn.status !== 'POSTED' || txn.postedAt === null || !isValidDate(txn.postedAt)) return err('TXN_NOT_POSTED');
  if (!isDisputableType(txn.type)) return err('TXN_TYPE_NOT_DISPUTABLE');
  if (!isWithinWindow(txn.postedAt, now)) return err('OUTSIDE_WINDOW');
  return ok(true);
};
