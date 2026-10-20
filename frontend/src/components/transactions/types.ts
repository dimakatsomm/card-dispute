import type { components } from '../../api/generated/transactions';

export type TransactionRow = components['schemas']['TransactionRow'];
export type EligibilityReason = components['schemas']['EligibilityReason'];
export type DisputeStatus = components['schemas']['DisputeStatus'];
export type TransactionStatus = components['schemas']['TransactionStatus'];
export type TransactionType = components['schemas']['TransactionType'];

export type TransactionFilter = Readonly<{ accountId?: string; cardId?: string }>;
