import type { components as DisputeSchemas } from '../../api/generated/disputes';
import type { components as TransactionSchemas } from '../../api/generated/transactions';

export type Tone = 'neutral' | 'info' | 'accent' | 'warning' | 'success' | 'danger';

export const toneClass: Readonly<Record<Tone, string>> = {
  neutral: 'bg-zinc-100 text-zinc-700 ring-zinc-500/15',
  info: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  accent: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  warning: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  danger: 'bg-red-50 text-red-700 ring-red-600/20',
};

export const disputeStatusTone: Readonly<Record<DisputeSchemas['schemas']['DisputeStatus'], Tone>> = {
  SUBMITTED: 'info',
  UNDER_REVIEW: 'warning',
  RESOLVED_ACCEPTED: 'success',
  RESOLVED_REJECTED: 'danger',
  WITHDRAWN: 'neutral',
};

export const transactionStatusTone: Readonly<Record<TransactionSchemas['schemas']['TransactionStatus'], Tone>> = {
  POSTED: 'neutral',
  PENDING: 'warning',
  DECLINED: 'danger',
  REVERSED: 'info',
};

export const evidenceStatusTone: Readonly<Record<DisputeSchemas['schemas']['Evidence']['status'], Tone>> = {
  PENDING: 'warning',
  STORED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'neutral',
  ERASED: 'neutral',
};
