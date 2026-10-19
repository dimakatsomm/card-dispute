import type pg from 'pg';
import { seedUser, type SeededUser } from './db.ts';

export type Fixture = { readonly a: SeededUser; readonly b: SeededUser };

export const CARD_TOKEN_PREFIX = 'tok_secret_';

// Relative to FIXED_NOW (2026-10-19): 09/2026 has passed, 10/2026 is still valid this month.
export const seedFixture = async (pool: pg.Pool): Promise<Fixture> => ({
  a: await seedUser(pool, {
    name: 'Thandi',
    email: 'thandi@example.com',
    accounts: [
      [
        { token: `${CARD_TOKEN_PREFIX}a1`, last4: '1111', expiryMonth: 9, expiryYear: 2026 },
        { token: `${CARD_TOKEN_PREFIX}a2`, last4: '2222', expiryMonth: 10, expiryYear: 2026 },
      ],
      [{ token: `${CARD_TOKEN_PREFIX}a3`, last4: '3333', expiryMonth: 12, expiryYear: 2030 }],
    ],
  }),
  b: await seedUser(pool, {
    name: 'Sipho',
    email: 'sipho@example.com',
    accounts: [[{ token: `${CARD_TOKEN_PREFIX}b1`, last4: '4444', expiryMonth: 12, expiryYear: 2030 }]],
  }),
});

export const cardIdsOf = (user: SeededUser): ReadonlyArray<string> => user.accounts.flatMap((a) => a.cardIds);

export const accountAt = (user: SeededUser, index: number): { readonly accountId: string; readonly cardIds: ReadonlyArray<string> } => {
  const account = user.accounts[index];
  if (!account) throw new Error(`fixture has no account ${index}`);
  return account;
};
