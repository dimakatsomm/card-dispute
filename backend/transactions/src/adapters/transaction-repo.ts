import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@cd/dispute-domain';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { LookupQuery, PageQuery, Transaction } from '../core/transaction.ts';

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

// Aliases differ from column names so ORDER BY binds to the indexed timestamptz, not the text projection.
const SELECT = `select transaction_id, account_id, card_id, amount::text as amount, currency, merchant_name, mcc,
  type, status,
  to_char(transaction_at at time zone 'UTC', ${ISO_US}) as transaction_at_text,
  to_char(posted_at at time zone 'UTC', ${ISO_US}) as posted_at_text
  from transaction`;

const ORDER = 'order by transaction_at desc, transaction_id desc';

const rowSchema = z
  .object({
    transaction_id: z.string(),
    account_id: z.string(),
    card_id: z.string(),
    amount: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.string().length(3),
    merchant_name: z.string(),
    mcc: z.string().nullable(),
    type: z.enum(TRANSACTION_TYPES),
    status: z.enum(TRANSACTION_STATUSES),
    transaction_at_text: z.string(),
    posted_at_text: z.string().nullable(),
  })
  .transform(
    (r): Transaction => ({
      transactionId: r.transaction_id,
      accountId: r.account_id,
      cardId: r.card_id,
      amount: r.amount,
      currency: r.currency,
      merchantName: r.merchant_name,
      mcc: r.mcc,
      type: r.type,
      status: r.status,
      transactionAt: r.transaction_at_text,
      postedAt: r.posted_at_text,
    }),
  );

type Condition = { readonly sql: (...params: ReadonlyArray<string>) => string; readonly values: ReadonlyArray<unknown> };

const when = (value: unknown, sql: Condition['sql']): ReadonlyArray<Condition> =>
  value === undefined ? [] : [{ sql, values: [value] }];

const compile = (conditions: ReadonlyArray<Condition>): { readonly where: string; readonly params: unknown[] } =>
  conditions.reduce<{ readonly where: string; readonly params: unknown[] }>(
    (acc, c) => {
      const names = c.values.map((_, i) => `$${acc.params.length + i + 1}`);
      return {
        where: acc.where === '' ? c.sql(...names) : `${acc.where} and ${c.sql(...names)}`,
        params: [...acc.params, ...c.values],
      };
    },
    { where: '', params: [] },
  );

const pageConditions = ({ userId, filter: f, after }: PageQuery): ReadonlyArray<Condition> => [
  { sql: (p) => `user_id = ${p}::uuid`, values: [userId] },
  ...when(f.accountId, (p) => `account_id = ${p}::uuid`),
  ...when(f.cardId, (p) => `card_id = ${p}::uuid`),
  ...when(f.transactionId, (p) => `transaction_id = ${p}::uuid`),
  ...when(f.from, (p) => `transaction_at >= ${p}::timestamptz`),
  ...when(f.to, (p) => `transaction_at < ${p}::timestamptz`),
  ...when(f.statuses, (p) => `status = any(${p}::text[])`),
  ...when(f.minAmount, (p) => `amount >= ${p}::numeric`),
  ...when(f.maxAmount, (p) => `amount <= ${p}::numeric`),
  ...(after === null
    ? []
    : [
        {
          sql: (at: string, id: string) => `(transaction_at, transaction_id) < (${at}::timestamptz, ${id}::uuid)`,
          values: [after.transactionAt, after.transactionId],
        },
      ]),
];

const lookupConditions = (q: LookupQuery): ReadonlyArray<Condition> => [
  { sql: (p) => `user_id = ${p}::uuid`, values: [q.userId] },
  { sql: (p) => `transaction_id = any(${p}::uuid[])`, values: [q.transactionIds] },
  ...when(q.accountId, (p) => `account_id = ${p}::uuid`),
  ...when(q.cardId, (p) => `card_id = ${p}::uuid`),
];

const parseRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<Transaction> => rows.map((r) => rowSchema.parse(r));

export type TransactionRepo = {
  readonly listPage: (query: PageQuery) => Promise<ReadonlyArray<Transaction>>;
  readonly lookup: (query: LookupQuery) => Promise<ReadonlyArray<Transaction>>;
  readonly now: () => Promise<Date>;
  readonly ping: () => Promise<boolean>;
};

export const createTransactionRepo = (pool: Pool): TransactionRepo => ({
  listPage: async (query) => {
    const { where, params } = compile(pageConditions(query));
    const result = await pool.query(`${SELECT} where ${where} ${ORDER} limit $${params.length + 1}`, [
      ...params,
      query.limit,
    ]);
    return parseRows(result.rows);
  },
  lookup: async (query) => {
    const { where, params } = compile(lookupConditions(query));
    const result = await pool.query(`${SELECT} where ${where} ${ORDER}`, params);
    return parseRows(result.rows);
  },
  now: async () => {
    const result = await pool.query<{ now: Date }>('select now() as now');
    const now = result.rows[0]?.now;
    if (!(now instanceof Date)) throw new Error('select now() returned no timestamp');
    return now;
  },
  ping: async () => {
    await pool.query('select 1');
    return true;
  },
});
