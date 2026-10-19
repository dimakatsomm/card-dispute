import { withTransaction } from '@cd/db';
import { CARD_STATUSES } from '@cd/dispute-domain';
import type pg from 'pg';
import { z } from 'zod';
import { CARD_BRANDS, CARD_TYPES, type CardRecord } from '../core/cards.ts';
import { ACCOUNT_STATUSES, ACCOUNT_TYPES, type AccountRecord, type ProfileRecord } from '../core/me.ts';
import type { CardFilter, Contact, UsersRepo } from '../use-cases/ports.ts';

const profileRow = z
  .object({
    user_id: z.string(),
    name: z.string(),
    surname: z.string(),
    email: z.string(),
    cellphone_number: z.string().nullable(),
  })
  .transform(
    (r): ProfileRecord => ({
      userId: r.user_id,
      name: r.name,
      surname: r.surname,
      email: r.email,
      cellphoneNumber: r.cellphone_number,
    }),
  );

const accountRow = z
  .object({
    account_id: z.string(),
    account_type: z.enum(ACCOUNT_TYPES),
    account_number_masked: z.string(),
    currency: z.string(),
    status: z.enum(ACCOUNT_STATUSES),
  })
  .transform(
    (r): AccountRecord => ({
      accountId: r.account_id,
      accountType: r.account_type,
      accountNumberMasked: r.account_number_masked,
      currency: r.currency,
      status: r.status,
    }),
  );

const cardRow = z
  .object({
    card_id: z.string(),
    account_id: z.string(),
    user_id: z.string(),
    brand: z.enum(CARD_BRANDS),
    card_type: z.enum(CARD_TYPES),
    last4: z.string(),
    expiry_month: z.number().int(),
    expiry_year: z.number().int(),
    status: z.enum(CARD_STATUSES),
  })
  .transform(
    (r): CardRecord => ({
      cardId: r.card_id,
      accountId: r.account_id,
      userId: r.user_id,
      brand: r.brand,
      cardType: r.card_type,
      last4: r.last4,
      expiryMonth: r.expiry_month,
      expiryYear: r.expiry_year,
      status: r.status,
    }),
  );

const contactRow = z
  .object({ user_id: z.string(), email: z.string(), name: z.string() })
  .transform((r): Contact => ({ userId: r.user_id, email: r.email, name: r.name }));

const PROFILE_SQL = `
  select user_id, name, surname, email, cellphone_number
    from app_user
   where user_id = $1`;

const ACCOUNTS_SQL = `
  select a.account_id, a.account_type, a.account_number_masked, a.currency, a.status
    from account a
    join app_user u on u.id = a.user_id
   where u.user_id = $1
   order by a.id`;

// Explicit column list: card.token must never leave this service.
const CARDS_SQL = `
  select c.card_id, a.account_id, u.user_id, c.brand, c.card_type, c.last4,
         c.expiry_month, c.expiry_year, c.status
    from card c
    join account a on a.id = c.account_id
    join app_user u on u.id = a.user_id
   where u.user_id = $1
     and ($2::uuid is null or a.account_id = $2::uuid)
     and ($3::uuid is null or c.card_id = $3::uuid)
   order by c.id`;

const CONTACT_SQL = `
  select user_id, email, name
    from app_user
   where user_id = $1`;

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

const selectCards = async (db: Queryable, filter: CardFilter): Promise<ReadonlyArray<CardRecord>> => {
  const res = await db.query(CARDS_SQL, [filter.userId, filter.accountId ?? null, filter.cardId ?? null]);
  return res.rows.map((row) => cardRow.parse(row));
};

export const createUsersRepo = (pool: pg.Pool): UsersRepo => ({
  findMe: (userId) =>
    withTransaction(pool, async (client) => {
      // One snapshot, so cards never reference an account the profile read did not see.
      await client.query('set transaction isolation level repeatable read, read only');
      const profile = await client.query(PROFILE_SQL, [userId]);
      if (profile.rows.length === 0) return null;
      const accounts = await client.query(ACCOUNTS_SQL, [userId]);
      return {
        profile: profileRow.parse(profile.rows[0]),
        accounts: accounts.rows.map((row) => accountRow.parse(row)),
        cards: await selectCards(client, { userId }),
      };
    }),

  findCards: (filter) => selectCards(pool, filter),

  findContact: async (userId) => {
    const res = await pool.query(CONTACT_SQL, [userId]);
    return res.rows.length === 0 ? null : contactRow.parse(res.rows[0]);
  },

  ping: async () => {
    await pool.query('select 1');
    return true;
  },
});
