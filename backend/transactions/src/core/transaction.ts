import type { TransactionStatus, TransactionType } from '@cd/dispute-domain';

export type Transaction = {
  readonly transactionId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly amount: string;
  readonly currency: string;
  readonly merchantName: string;
  readonly mcc: string | null;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  // Microsecond ISO text straight from Postgres: a JS Date would truncate and break cursor ties.
  readonly transactionAt: string;
  readonly postedAt: string | null;
};

export type CursorPosition = { readonly transactionAt: string; readonly transactionId: string };

export type ListFilter = {
  readonly accountId?: string | undefined;
  readonly cardId?: string | undefined;
  readonly transactionId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly statuses?: ReadonlyArray<TransactionStatus> | undefined;
  readonly minAmount?: string | undefined;
  readonly maxAmount?: string | undefined;
};

export type PageQuery = {
  readonly userId: string;
  readonly filter: ListFilter;
  readonly after: CursorPosition | null;
  readonly limit: number;
};

export type LookupQuery = {
  readonly userId: string;
  readonly transactionIds: ReadonlyArray<string>;
  readonly accountId?: string | undefined;
  readonly cardId?: string | undefined;
};
