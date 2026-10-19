import type { CardRecord } from '../core/cards.ts';
import type { MeRecord } from '../core/me.ts';

export type CardFilter = {
  readonly userId: string;
  readonly accountId?: string | undefined;
  readonly cardId?: string | undefined;
};

export type Contact = { readonly userId: string; readonly email: string; readonly name: string };

export type UsersRepo = {
  readonly findMe: (userId: string) => Promise<MeRecord | null>;
  readonly findCards: (filter: CardFilter) => Promise<ReadonlyArray<CardRecord>>;
  readonly findContact: (userId: string) => Promise<Contact | null>;
  readonly ping: () => Promise<boolean>;
};
