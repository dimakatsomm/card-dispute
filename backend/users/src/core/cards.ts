import { isCardExpired, type CardStatus } from '@cd/dispute-domain';

export const CARD_BRANDS = Object.freeze(['VISA', 'MASTERCARD', 'AMEX'] as const);
export type CardBrand = (typeof CARD_BRANDS)[number];

export const CARD_TYPES = Object.freeze(['DEBIT', 'CREDIT'] as const);
export type CardType = (typeof CARD_TYPES)[number];

export type CardRecord = {
  readonly cardId: string;
  readonly accountId: string;
  readonly userId: string;
  readonly brand: CardBrand;
  readonly cardType: CardType;
  readonly last4: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly status: CardStatus;
};

export type Card = {
  readonly cardId: string;
  readonly accountId: string;
  readonly brand: CardBrand;
  readonly cardType: CardType;
  readonly last4: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly expired: boolean;
  readonly status: CardStatus;
};

export type UserCard = Card & { readonly userId: string };

export const toCard = (record: CardRecord, now: Date): Card => ({
  cardId: record.cardId,
  accountId: record.accountId,
  brand: record.brand,
  cardType: record.cardType,
  last4: record.last4,
  expiryMonth: record.expiryMonth,
  expiryYear: record.expiryYear,
  expired: isCardExpired(record, now),
  status: record.status,
});

export const toUserCard = (record: CardRecord, now: Date): UserCard => ({
  ...toCard(record, now),
  userId: record.userId,
});
