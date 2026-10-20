import type { components } from '../../api/generated/disputes';
import { codePointLength } from '../../components/evidence';
import type { ReasonCode } from '../../lib/dispute-reasons';

export type CreateDisputeRequest = components['schemas']['CreateDisputeRequest'];

export const REASON_LABELS: Readonly<Record<ReasonCode, string>> = {
  FRAUD: "I didn't make this transaction (fraud)",
  NOT_RECEIVED: "I didn't receive the goods or service",
  DUPLICATE: 'I was charged more than once',
  INCORRECT_AMOUNT: 'I was charged the wrong amount',
  CANCELLED_SUBSCRIPTION: 'I was charged after cancelling a subscription',
  DEFECTIVE_GOODS: 'The goods were faulty or not as described',
  OTHER: 'Something else',
};

export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 2000;

export type DescriptionProblem = 'TOO_SHORT' | 'TOO_LONG';

export const checkDescription = (value: string): DescriptionProblem | null => {
  const length = codePointLength(value);
  if (length < DESCRIPTION_MIN) return 'TOO_SHORT';
  if (length > DESCRIPTION_MAX) return 'TOO_LONG';
  return null;
};

const INVALID_MESSAGES = {
  INVALID_REASON: 'Choose a valid reason for the dispute.',
  INVALID_DESCRIPTION: `The description must be between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters.`,
} as const;

export type InvalidCode = keyof typeof INVALID_MESSAGES;

const isInvalidCode = (code: string): code is InvalidCode => Object.hasOwn(INVALID_MESSAGES, code);

export const toInvalidCode = (code: string | null): InvalidCode | null =>
  code !== null && isInvalidCode(code) ? code : null;

export type CreateFailure =
  | { readonly kind: 'ALREADY_DISPUTED' }
  | { readonly kind: 'NOT_ELIGIBLE'; readonly code: string | null }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID'; readonly code: InvalidCode | null }
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'UNEXPECTED' };

const NOT_ELIGIBLE_MESSAGES: Readonly<Record<string, string>> = {
  CARD_EXPIRED: 'The card used for this transaction has expired, so it can no longer be disputed.',
  TXN_NOT_POSTED: "This transaction hasn't posted yet. You can dispute it once it has posted.",
  TXN_TYPE_NOT_DISPUTABLE: "This type of transaction can't be disputed.",
  OUTSIDE_WINDOW: 'This transaction is outside the period in which it can be disputed.',
};

export const createFailureMessage = (failure: Exclude<CreateFailure, { kind: 'ALREADY_DISPUTED' }>): string => {
  switch (failure.kind) {
    case 'NOT_ELIGIBLE':
      return (failure.code !== null && Object.hasOwn(NOT_ELIGIBLE_MESSAGES, failure.code)
        ? NOT_ELIGIBLE_MESSAGES[failure.code]
        : undefined) ?? "This transaction can't be disputed.";
    case 'NOT_FOUND':
      return "We couldn't find this transaction.";
    case 'INVALID':
      return failure.code !== null ? INVALID_MESSAGES[failure.code] : "Some details weren't accepted. Check the form and try again.";
    case 'UNAVAILABLE':
      return 'The service is temporarily unavailable. Try again in a moment.';
    case 'UNEXPECTED':
      return 'Something went wrong. Try again.';
  }
};
