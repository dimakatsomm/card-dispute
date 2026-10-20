import type { TransactionRow } from '../../src/components/transactions/types';
import type { Me } from '../../src/screens/home/useMe';

export const ids = {
  accountA: '0192f0c1-0000-7000-8000-0000000000a1',
  accountB: '0192f0c1-0000-7000-8000-0000000000a2',
  cardA: '0192f0c1-0000-7000-8000-0000000000c1',
  cardAExpired: '0192f0c1-0000-7000-8000-0000000000c2',
  cardB: '0192f0c1-0000-7000-8000-0000000000c3',
} as const;

export const me: Me = {
  userId: '0192f0c1-0000-7000-8000-000000000002',
  name: 'Thandi',
  surname: 'Nkosi',
  email: 'thandi@example.com',
  cellphoneNumber: null,
  accounts: [
    {
      accountId: ids.accountA,
      accountType: 'CHEQUE',
      accountNumberMasked: '****4821',
      currency: 'ZAR',
      status: 'ACTIVE',
      cards: [
        { cardId: ids.cardA, accountId: ids.accountA, brand: 'VISA', cardType: 'DEBIT', last4: '1111', expiryMonth: 9, expiryYear: 2028, expired: false, status: 'ACTIVE' },
        { cardId: ids.cardAExpired, accountId: ids.accountA, brand: 'VISA', cardType: 'DEBIT', last4: '2222', expiryMonth: 1, expiryYear: 2024, expired: true, status: 'ACTIVE' },
      ],
    },
    {
      accountId: ids.accountB,
      accountType: 'SAVINGS',
      accountNumberMasked: '****9999',
      currency: 'ZAR',
      status: 'ACTIVE',
      cards: [
        { cardId: ids.cardB, accountId: ids.accountB, brand: 'MASTERCARD', cardType: 'CREDIT', last4: '3333', expiryMonth: 12, expiryYear: 2029, expired: false, status: 'ACTIVE' },
      ],
    },
  ],
};

export const txn = (n: number, overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  transactionId: `0192f0c1-0000-7000-8000-${String(n).padStart(12, '0')}`,
  accountId: ids.accountA,
  cardId: ids.cardA,
  amount: '125.50',
  currency: 'ZAR',
  merchantName: `Merchant ${n}`,
  mcc: '5814',
  type: 'PURCHASE',
  status: 'POSTED',
  transactionAt: '2026-09-28T10:15:00Z',
  postedAt: '2026-09-29T02:00:00Z',
  dispute: null,
  disputable: { allowed: true },
  ...overrides,
});

export const page = (items: ReadonlyArray<TransactionRow>, nextCursor: string | null = null) => ({ items, nextCursor });
