import type { EligibilityReason } from './types';

// Wording only: eligibility is decided server-side by the shared rules (ADR-021), never here.
export const reasonMessages: Readonly<Record<EligibilityReason, string>> = {
  ALREADY_DISPUTED: 'This transaction has already been disputed.',
  CARD_EXPIRED: "This card has expired, so its transactions can't be disputed.",
  TXN_NOT_POSTED: 'Only posted transactions can be disputed.',
  TXN_TYPE_NOT_DISPUTABLE: "This type of transaction can't be disputed.",
  OUTSIDE_WINDOW: 'The time limit for disputing this transaction has passed.',
  UNAVAILABLE: 'Disputes are temporarily unavailable. Please try again later.',
};

// Fail closed: a not-allowed row without a reason is treated like a dependency outage.
export const reasonMessage = (reason: EligibilityReason | undefined): string =>
  reasonMessages[reason ?? 'UNAVAILABLE'];
