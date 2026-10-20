import type { components } from '../api/generated/disputes';

export type ReasonCode = components['schemas']['ReasonCode'];

// Fails to compile if the contract adds a reason code that is not listed here.
const allReasonCodes = <const T extends ReadonlyArray<ReasonCode>>(
  codes: T & ([Exclude<ReasonCode, T[number]>] extends [never] ? unknown : never),
): T => codes;

export const REASON_CODES: ReadonlyArray<ReasonCode> = allReasonCodes([
  'FRAUD',
  'NOT_RECEIVED',
  'DUPLICATE',
  'INCORRECT_AMOUNT',
  'CANCELLED_SUBSCRIPTION',
  'DEFECTIVE_GOODS',
  'OTHER',
]);

export const isReasonCode = (value: string): value is ReasonCode => REASON_CODES.some((code) => code === value);
