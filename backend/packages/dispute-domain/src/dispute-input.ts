import { err, ok, type Result } from '@cd/shared/fp';
import { isReasonCode, type ReasonCode } from './reason-codes.ts';

export const DESCRIPTION_MIN_CHARS = 10;
export const DESCRIPTION_MAX_CHARS = 2000;

export type DisputeInput = {
  readonly reasonCode: string;
  readonly description: string;
};

export type ValidDisputeInput = {
  readonly reasonCode: ReasonCode;
  readonly description: string;
};

export type InputError = 'INVALID_REASON' | 'INVALID_DESCRIPTION';

// Counts code points, not UTF-16 units, to agree with the DB CHECK on length(description).
const charCount = (s: string): number => [...s].length;

export const validateDisputeInput = (input: DisputeInput): Result<ValidDisputeInput, InputError> => {
  const { reasonCode, description } = input;
  if (!isReasonCode(reasonCode)) return err('INVALID_REASON');
  const length = charCount(description);
  if (length < DESCRIPTION_MIN_CHARS || length > DESCRIPTION_MAX_CHARS) return err('INVALID_DESCRIPTION');
  return ok({ reasonCode, description });
};
