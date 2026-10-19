import { toCard, type Card, type CardRecord } from './cards.ts';

export const ACCOUNT_TYPES = Object.freeze(['CHEQUE', 'SAVINGS', 'CREDIT'] as const);
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_STATUSES = Object.freeze(['ACTIVE', 'FROZEN', 'CLOSED'] as const);
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type ProfileRecord = {
  readonly userId: string;
  readonly name: string;
  readonly surname: string;
  readonly email: string;
  readonly cellphoneNumber: string | null;
};

export type AccountRecord = {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly accountNumberMasked: string;
  readonly currency: string;
  readonly status: AccountStatus;
};

export type MeRecord = {
  readonly profile: ProfileRecord;
  readonly accounts: ReadonlyArray<AccountRecord>;
  readonly cards: ReadonlyArray<CardRecord>;
};

export type Account = AccountRecord & { readonly cards: ReadonlyArray<Card> };

export type Me = ProfileRecord & { readonly accounts: ReadonlyArray<Account> };

export const assembleMe = ({ profile, accounts, cards }: MeRecord, now: Date): Me => ({
  userId: profile.userId,
  name: profile.name,
  surname: profile.surname,
  email: profile.email,
  cellphoneNumber: profile.cellphoneNumber,
  accounts: accounts.map((account) => ({
    accountId: account.accountId,
    accountType: account.accountType,
    accountNumberMasked: account.accountNumberMasked,
    currency: account.currency,
    status: account.status,
    cards: cards.filter((card) => card.accountId === account.accountId).map((card) => toCard(card, now)),
  })),
});
