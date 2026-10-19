export const REASON_CODES = Object.freeze([
  'FRAUD',
  'NOT_RECEIVED',
  'DUPLICATE',
  'INCORRECT_AMOUNT',
  'CANCELLED_SUBSCRIPTION',
  'DEFECTIVE_GOODS',
  'OTHER',
] as const);

export type ReasonCode = (typeof REASON_CODES)[number];

export const isReasonCode = (value: string): value is ReasonCode =>
  (REASON_CODES as ReadonlyArray<string>).includes(value);
