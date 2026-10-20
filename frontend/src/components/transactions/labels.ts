import type { DisputeStatus, TransactionStatus, TransactionType } from './types';

export const transactionStatusLabels: Readonly<Record<TransactionStatus, string>> = {
  PENDING: 'Pending',
  POSTED: 'Posted',
  DECLINED: 'Declined',
  REVERSED: 'Reversed',
};

export const transactionTypeLabels: Readonly<Record<TransactionType, string>> = {
  PURCHASE: 'Purchase',
  REFUND: 'Refund',
  ATM_WITHDRAWAL: 'ATM withdrawal',
  FEE: 'Fee',
};

export const disputeStatusLabels: Readonly<Record<DisputeStatus, string>> = {
  SUBMITTED: 'Dispute submitted',
  UNDER_REVIEW: 'Dispute under review',
  RESOLVED_ACCEPTED: 'Dispute accepted',
  RESOLVED_REJECTED: 'Dispute rejected',
  WITHDRAWN: 'Dispute withdrawn',
};
