import { TRANSACTION_STATUSES } from '@cd/dispute-domain';
import { lteMoney } from '@cd/shared';
import { z } from 'zod';

const uuid = z.guid();
const money = z.string().regex(/^[0-9]{1,10}\.[0-9]{2}$/, 'must be a decimal string with 2 places');
const MAX_OFFSET_MINUTES = 14 * 60;

// zod accepts year 0000 and offsets up to ±23:59; Postgres rejects both, which would surface as a 500.
const isStorableTimestamp = (s: string): boolean => {
  const offset = /[+-](\d{2}):?(\d{2})$/.exec(s);
  return !s.startsWith('0000') && (offset === null || Number(offset[1]) * 60 + Number(offset[2]) <= MAX_OFFSET_MINUTES);
};

const timestamp = z.iso.datetime({ offset: true }).refine(isStorableTimestamp, 'must be a storable timestamp');
const MAX_IDS = 100;

const asArray = (value: unknown): unknown => (typeof value === 'string' ? [value] : value);

export const listQuerySchema = z
  .object({
    accountId: uuid.optional(),
    cardId: uuid.optional(),
    transactionId: uuid.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
    status: z.preprocess(asArray, z.array(z.enum(TRANSACTION_STATUSES)).min(1).max(10)).optional(),
    minAmount: money.optional(),
    maxAmount: money.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || Date.parse(q.from) < Date.parse(q.to), {
    path: ['to'],
    message: 'must be after from',
  })
  .refine(
    (q) => {
      if (q.minAmount === undefined || q.maxAmount === undefined) return true;
      const lte = lteMoney(q.minAmount, q.maxAmount);
      return lte.ok && lte.value;
    },
    { path: ['maxAmount'], message: 'must be at least minAmount' },
  );

export const lookupQuerySchema = z.object({
  userId: uuid,
  transactionIds: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(uuid).min(1).max(MAX_IDS)),
  accountId: uuid.optional(),
  cardId: uuid.optional(),
});
