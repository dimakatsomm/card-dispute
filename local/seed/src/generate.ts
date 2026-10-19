import { createRng, intBetween, pick, stableUuid, type Rng } from './random.ts';

export const DEFAULT_SEED = 20261019;
export const CURRENCY = 'ZAR';
export const HISTORY_DAYS = 180;
export const RANDOM_TXNS_PER_USER = 200;

export type UserKey = 'A' | 'B' | 'C' | 'D';
type AccountType = 'CHEQUE' | 'SAVINGS' | 'CREDIT';
type Brand = 'VISA' | 'MASTERCARD' | 'AMEX';
type CardType = 'DEBIT' | 'CREDIT';
type TxnType = 'PURCHASE' | 'REFUND' | 'ATM_WITHDRAWAL' | 'FEE';
type TxnStatus = 'PENDING' | 'POSTED' | 'DECLINED' | 'REVERSED';
type DisputeStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'WITHDRAWN';
type HistoryAction = 'CREATE' | 'REVIEW' | 'RESOLVE' | 'WITHDRAW';
type ActorType = 'USER' | 'AGENT';

export type AppUserRow = {
  readonly user_id: string;
  readonly auth_id: string;
  readonly name: string;
  readonly surname: string;
  readonly cellphone_number: string;
  readonly email: string;
  readonly status: 'ACTIVE' | 'CLOSED';
};

export type AuthIdentityRow = {
  readonly auth_id: string;
  readonly cognito_sub: string;
  readonly username: string;
  readonly user_id: string;
  readonly status: 'ACTIVE' | 'DISABLED';
};

export type AccountRow = {
  readonly account_id: string;
  readonly user_id: string;
  readonly account_number_masked: string;
  readonly account_type: AccountType;
  readonly currency: string;
};

export type CardRow = {
  readonly card_id: string;
  readonly account_id: string;
  readonly token: string;
  readonly last4: string;
  readonly expiry_month: number;
  readonly expiry_year: number;
  readonly brand: Brand;
  readonly card_type: CardType;
};

export type TransactionRow = {
  readonly transaction_id: string;
  readonly user_id: string;
  readonly account_id: string;
  readonly card_id: string;
  readonly amount: string;
  readonly currency: string;
  readonly merchant_name: string;
  readonly mcc: string | null;
  readonly type: TxnType;
  readonly status: TxnStatus;
  readonly transaction_at: string;
  readonly posted_at: string | null;
};

export type HistoryRow = {
  readonly dispute_id: string;
  readonly seq: number;
  readonly action: HistoryAction;
  readonly from_status: DisputeStatus | null;
  readonly to_status: DisputeStatus;
  readonly actor_type: ActorType;
  readonly actor_id: string;
  readonly note: string | null;
  readonly after: Readonly<Record<string, string>> | null;
  readonly created_at: string;
};

export type DisputeRow = {
  readonly dispute_id: string;
  readonly transaction_id: string;
  readonly user_id: string;
  readonly reason_code: string;
  readonly description: string;
  readonly status: DisputeStatus;
  readonly version: number;
  readonly resolved_at: string | null;
  readonly resolution_note: string | null;
  readonly created_by: string;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type SeedData = {
  readonly appUsers: ReadonlyArray<AppUserRow>;
  readonly authIdentities: ReadonlyArray<AuthIdentityRow>;
  readonly accounts: ReadonlyArray<AccountRow>;
  readonly cards: ReadonlyArray<CardRow>;
  readonly transactions: ReadonlyArray<TransactionRow>;
  readonly disputes: ReadonlyArray<DisputeRow>;
  readonly history: ReadonlyArray<HistoryRow>;
};

type CardSpec = { readonly key: string; readonly brand: Brand; readonly cardType: CardType; readonly expired: boolean };
type AccountSpec = { readonly key: string; readonly type: AccountType; readonly cards: ReadonlyArray<CardSpec> };
type Persona = {
  readonly key: UserKey;
  readonly sub: string;
  readonly username: string;
  readonly name: string;
  readonly surname: string;
  readonly cellphone: string;
  readonly disabled: boolean;
  readonly accounts: ReadonlyArray<AccountSpec>;
};

const card = (key: string, brand: Brand, cardType: CardType, expired = false): CardSpec => ({
  key,
  brand,
  cardType,
  expired,
});

// Subs and usernames must match local/mock-issuer SEED_USERS; +27 0… numbers are not diallable in South Africa.
const PERSONAS: ReadonlyArray<Persona> = [
  {
    key: 'A',
    sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    username: 'thandi.nkosi',
    name: 'Thandi',
    surname: 'Nkosi',
    cellphone: '+27000000001',
    disabled: false,
    accounts: [
      {
        key: 'A-CHQ',
        type: 'CHEQUE',
        cards: [card('A-CHQ-1', 'VISA', 'DEBIT'), card('A-CHQ-OLD', 'MASTERCARD', 'DEBIT', true)],
      },
      { key: 'A-CRD', type: 'CREDIT', cards: [card('A-CRD-1', 'MASTERCARD', 'CREDIT')] },
    ],
  },
  {
    key: 'B',
    sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    username: 'sipho.dlamini',
    name: 'Sipho',
    surname: 'Dlamini',
    cellphone: '+27000000002',
    disabled: false,
    accounts: [{ key: 'B-CHQ', type: 'CHEQUE', cards: [card('B-CHQ-1', 'VISA', 'DEBIT'), card('B-CHQ-2', 'VISA', 'DEBIT')] }],
  },
  {
    key: 'C',
    sub: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    username: 'lerato.mokoena',
    name: 'Lerato',
    surname: 'Mokoena',
    cellphone: '+27000000003',
    disabled: false,
    accounts: [
      { key: 'C-SAV', type: 'SAVINGS', cards: [card('C-SAV-1', 'MASTERCARD', 'DEBIT')] },
      { key: 'C-CRD', type: 'CREDIT', cards: [card('C-CRD-1', 'AMEX', 'CREDIT')] },
    ],
  },
  {
    key: 'D',
    sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    username: 'dumisani.zulu',
    name: 'Dumisani',
    surname: 'Zulu',
    cellphone: '+27000000004',
    disabled: true,
    accounts: [],
  },
];

export const userId = (key: UserKey): string => stableUuid(`user:${key}`);
export const authId = (key: UserKey): string => stableUuid(`auth:${key}`);
export const accountId = (key: string): string => stableUuid(`account:${key}`);
export const cardId = (key: string): string => stableUuid(`card:${key}`);
export const transactionId = (key: string): string => stableUuid(`txn:${key}`);
export const disputeId = (key: string): string => stableUuid(`dispute:${key}`);

export const SPECIAL_TXN = {
  posted119: 'A-POSTED-119',
  posted121: 'A-POSTED-121',
  pending: 'A-PENDING',
  declined: 'A-DECLINED',
  refund: 'A-REFUND',
  duplicate1: 'A-DUP-1',
  duplicate2: 'A-DUP-2',
  expiredCard1: 'A-EXPIRED-CARD-1',
  expiredCard2: 'A-EXPIRED-CARD-2',
  expiredCard3: 'A-EXPIRED-CARD-3',
  underReview: 'A-DISPUTE-UNDER-REVIEW',
  accepted: 'A-DISPUTE-ACCEPTED',
  rejected: 'A-DISPUTE-REJECTED',
  withdrawn: 'A-DISPUTE-WITHDRAWN',
} as const;

export const EXPIRED_CARD_KEY = 'A-CHQ-OLD';
const A_MAIN_CARD = 'A-CHQ-1';
const AGENT_ID = 'seed-agent-01';

type Merchant = { readonly name: string; readonly mcc: string; readonly minCents: number; readonly maxCents: number };

const MERCHANTS: ReadonlyArray<Merchant> = [
  { name: 'Jacaranda Grocers', mcc: '5411', minCents: 4_500, maxCents: 185_000 },
  { name: 'Protea Fuel Stop', mcc: '5541', minCents: 20_000, maxCents: 120_000 },
  { name: 'Baobab Coffee Roasters', mcc: '5814', minCents: 2_800, maxCents: 9_500 },
  { name: 'Fynbos Pharmacy', mcc: '5912', minCents: 6_000, maxCents: 60_000 },
  { name: 'Karoo Online Books', mcc: '5942', minCents: 15_000, maxCents: 90_000 },
  { name: 'Seedtown Streaming', mcc: '4899', minCents: 9_900, maxCents: 19_900 },
  { name: 'Highveld Hardware', mcc: '5200', minCents: 5_000, maxCents: 250_000 },
  { name: 'Umhlanga Eats', mcc: '5812', minCents: 12_000, maxCents: 80_000 },
  { name: 'Kalahari Air Travel', mcc: '4511', minCents: 120_000, maxCents: 650_000 },
  { name: 'Drakensberg Outdoor Gear', mcc: '5941', minCents: 25_000, maxCents: 400_000 },
];
const ATM: Merchant = { name: 'Seed Bank ATM Rosebank', mcc: '6011', minCents: 20_000, maxCents: 300_000 };
const FEE: Merchant = { name: 'Seed Bank monthly fee', mcc: '6012', minCents: 6_500, maxCents: 6_500 };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const utcMidnight = (now: Date): number => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

// Days before `now`'s UTC date, plus hours into that day: matches the domain's whole-UTC-day window counting.
const daysAgo = (now: Date, days: number, hours = 0): Date => new Date(utcMidnight(now) - days * DAY_MS + hours * HOUR_MS);

const iso = (d: Date): string => d.toISOString();

// Cents stay integers end to end; the string is what lands in numeric(12,2).
const formatCents = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const digits = (r: Rng, key: string, n: number): string =>
  Array.from({ length: n }, (_, i) => String(Math.floor(r(key, 'digit', i) * 10))).join('');

const lastMonth = (now: Date): { readonly month: number; readonly year: number } => {
  const m = now.getUTCMonth();
  return m === 0 ? { month: 12, year: now.getUTCFullYear() - 1 } : { month: m, year: now.getUTCFullYear() };
};

type CardRef = { readonly user: UserKey; readonly accountKey: string; readonly cardKey: string };

const appUserRow = (p: Persona): AppUserRow => ({
  user_id: userId(p.key),
  auth_id: authId(p.key),
  name: p.name,
  surname: p.surname,
  cellphone_number: p.cellphone,
  email: `${p.username}@example.com`,
  status: p.disabled ? 'CLOSED' : 'ACTIVE',
});

const authIdentityRow = (p: Persona): AuthIdentityRow => ({
  auth_id: authId(p.key),
  cognito_sub: p.sub,
  username: p.username,
  user_id: userId(p.key),
  status: p.disabled ? 'DISABLED' : 'ACTIVE',
});

const accountRow = (r: Rng, p: Persona, a: AccountSpec): AccountRow => ({
  account_id: accountId(a.key),
  user_id: userId(p.key),
  account_number_masked: `****${digits(r, a.key, 4)}`,
  account_type: a.type,
  currency: CURRENCY,
});

const cardRow = (r: Rng, now: Date, a: AccountSpec, c: CardSpec): CardRow => {
  const expiry = c.expired
    ? lastMonth(now)
    : { month: intBetween(r(c.key, 'exp-m'), 1, 12), year: now.getUTCFullYear() + intBetween(r(c.key, 'exp-y'), 1, 4) };
  return {
    card_id: cardId(c.key),
    account_id: accountId(a.key),
    token: `tok_seed_${cardId(c.key).replaceAll('-', '')}`,
    last4: digits(r, c.key, 4),
    expiry_month: expiry.month,
    expiry_year: expiry.year,
    brand: c.brand,
    card_type: c.cardType,
  };
};

const cardRefs = (p: Persona): ReadonlyArray<CardRef> =>
  p.accounts.flatMap((a) => a.cards.map((c) => ({ user: p.key, accountKey: a.key, cardKey: c.key })));

const txnRow = (
  key: string,
  ref: CardRef,
  merchant: Merchant,
  cents: number,
  type: TxnType,
  status: TxnStatus,
  at: Date,
  postedAt: Date | null,
): TransactionRow => ({
  transaction_id: transactionId(key),
  user_id: userId(ref.user),
  account_id: accountId(ref.accountKey),
  card_id: cardId(ref.cardKey),
  amount: formatCents(cents),
  currency: CURRENCY,
  merchant_name: merchant.name,
  mcc: merchant.mcc,
  type,
  status,
  transaction_at: iso(at),
  posted_at: postedAt === null ? null : iso(postedAt),
});

const randomType = (r: number): TxnType => (r < 0.05 ? 'FEE' : r < 0.13 ? 'ATM_WITHDRAWAL' : r < 0.2 ? 'REFUND' : 'PURCHASE');

// Rows from the last two days are still settling; older ones mostly POSTED with a little noise.
const randomStatus = (day: number, r: number): TxnStatus =>
  day <= 2 ? (r < 0.85 ? 'PENDING' : 'DECLINED') : r < 0.03 ? 'DECLINED' : r < 0.04 ? 'REVERSED' : 'POSTED';

const randomTransaction = (r: Rng, now: Date, p: Persona, refs: ReadonlyArray<CardRef>, i: number): TransactionRow => {
  const key = `${p.key}-RND-${i}`;
  const type = randomType(r(key, 'type'));
  const merchant = type === 'FEE' ? FEE : type === 'ATM_WITHDRAWAL' ? ATM : pick(MERCHANTS, r(key, 'merchant'));
  const raw = intBetween(r(key, 'amount'), merchant.minCents, merchant.maxCents);
  // ATMs dispense whole R100 notes.
  const cents = type === 'ATM_WITHDRAWAL' ? Math.round(raw / 10_000) * 10_000 : raw;
  const day = intBetween(r(key, 'day'), 1, HISTORY_DAYS);
  const at = daysAgo(now, day, intBetween(r(key, 'hour'), 6, 21) + r(key, 'min'));
  const status = randomStatus(day, r(key, 'status'));
  const settles = status === 'POSTED' || status === 'REVERSED';
  const postedAt = settles ? new Date(at.getTime() + intBetween(r(key, 'lag'), 1, 36) * HOUR_MS) : null;
  return txnRow(key, pick(refs, r(key, 'card')), merchant, cents, type, status, at, postedAt);
};

const merchantNamed = (name: string): Merchant => {
  const m = MERCHANTS.find((x) => x.name === name);
  if (m === undefined) throw new Error(`unknown merchant ${name}`);
  return m;
};

const aRef = (cardKey: string): CardRef => ({
  user: 'A',
  accountKey: cardKey === 'A-CRD-1' ? 'A-CRD' : 'A-CHQ',
  cardKey,
});

const postedOn = (
  now: Date,
  key: string,
  cardKey: string,
  merchant: string,
  cents: number,
  day: number,
  type: TxnType = 'PURCHASE',
): TransactionRow =>
  txnRow(key, aRef(cardKey), merchantNamed(merchant), cents, type, 'POSTED', daysAgo(now, day, 8), daysAgo(now, day, 10));

const specialTransactions = (now: Date): ReadonlyArray<TransactionRow> => [
  postedOn(now, SPECIAL_TXN.posted119, A_MAIN_CARD, 'Highveld Hardware', 189_950, 119),
  postedOn(now, SPECIAL_TXN.posted121, A_MAIN_CARD, 'Highveld Hardware', 74_900, 121),
  txnRow(SPECIAL_TXN.pending, aRef(A_MAIN_CARD), merchantNamed('Umhlanga Eats'), 45_600, 'PURCHASE', 'PENDING', daysAgo(now, 1, 19), null),
  txnRow(SPECIAL_TXN.declined, aRef(A_MAIN_CARD), merchantNamed('Kalahari Air Travel'), 512_000, 'PURCHASE', 'DECLINED', daysAgo(now, 5, 14), null),
  postedOn(now, SPECIAL_TXN.refund, A_MAIN_CARD, 'Karoo Online Books', 34_999, 10, 'REFUND'),
  // Same merchant and amount ~25h apart: the classic double charge.
  txnRow(SPECIAL_TXN.duplicate1, aRef(A_MAIN_CARD), merchantNamed('Seedtown Streaming'), 15_999, 'PURCHASE', 'POSTED', daysAgo(now, 21, 9), daysAgo(now, 20, 9)),
  txnRow(SPECIAL_TXN.duplicate2, aRef(A_MAIN_CARD), merchantNamed('Seedtown Streaming'), 15_999, 'PURCHASE', 'POSTED', daysAgo(now, 20, 10), daysAgo(now, 19, 10)),
  postedOn(now, SPECIAL_TXN.expiredCard1, EXPIRED_CARD_KEY, 'Jacaranda Grocers', 82_340, 7),
  postedOn(now, SPECIAL_TXN.expiredCard2, EXPIRED_CARD_KEY, 'Protea Fuel Stop', 95_000, 14),
  postedOn(now, SPECIAL_TXN.expiredCard3, EXPIRED_CARD_KEY, 'Fynbos Pharmacy', 23_475, 30),
  postedOn(now, SPECIAL_TXN.underReview, A_MAIN_CARD, 'Drakensberg Outdoor Gear', 249_900, 30),
  postedOn(now, SPECIAL_TXN.accepted, 'A-CRD-1', 'Kalahari Air Travel', 389_000, 60),
  postedOn(now, SPECIAL_TXN.rejected, 'A-CRD-1', 'Umhlanga Eats', 61_250, 90),
  postedOn(now, SPECIAL_TXN.withdrawn, A_MAIN_CARD, 'Baobab Coffee Roasters', 6_400, 40),
];

type Step = {
  readonly action: HistoryAction;
  readonly to: DisputeStatus;
  readonly day: number;
  readonly note?: string;
};

type DisputeSpec = {
  readonly txnKey: string;
  readonly reason: string;
  readonly description: string;
  readonly createdDay: number;
  readonly steps: ReadonlyArray<Step>;
};

const DISPUTE_SPECS: ReadonlyArray<DisputeSpec> = [
  {
    txnKey: SPECIAL_TXN.underReview,
    reason: 'NOT_RECEIVED',
    description: 'Ordered a tent online and it never arrived after three weeks.',
    createdDay: 28,
    steps: [{ action: 'REVIEW', to: 'UNDER_REVIEW', day: 26 }],
  },
  {
    txnKey: SPECIAL_TXN.accepted,
    reason: 'OTHER',
    description: 'Flight was cancelled by the airline and no refund was issued.',
    createdDay: 58,
    steps: [
      { action: 'REVIEW', to: 'UNDER_REVIEW', day: 55 },
      { action: 'RESOLVE', to: 'RESOLVED_ACCEPTED', day: 45, note: 'Merchant confirmed the cancellation; full amount refunded.' },
    ],
  },
  {
    txnKey: SPECIAL_TXN.rejected,
    reason: 'DEFECTIVE_GOODS',
    description: 'Meal delivered cold and missing items from the order.',
    createdDay: 88,
    steps: [
      { action: 'REVIEW', to: 'UNDER_REVIEW', day: 85 },
      { action: 'RESOLVE', to: 'RESOLVED_REJECTED', day: 70, note: 'Merchant provided proof of complete delivery.' },
    ],
  },
  {
    txnKey: SPECIAL_TXN.withdrawn,
    reason: 'INCORRECT_AMOUNT',
    description: 'Charged for a large coffee but only bought a small one.',
    createdDay: 38,
    steps: [{ action: 'WITHDRAW', to: 'WITHDRAWN', day: 35 }],
  },
];

const actorOf = (action: HistoryAction): { readonly type: ActorType; readonly id: string } =>
  action === 'REVIEW' || action === 'RESOLVE' ? { type: 'AGENT', id: AGENT_ID } : { type: 'USER', id: userId('A') };

const disputeRows = (now: Date, spec: DisputeSpec): { readonly dispute: DisputeRow; readonly history: ReadonlyArray<HistoryRow> } => {
  const id = disputeId(spec.txnKey);
  const user = userId('A');
  const created: HistoryRow = {
    dispute_id: id,
    seq: 0,
    action: 'CREATE',
    from_status: null,
    to_status: 'SUBMITTED',
    actor_type: 'USER',
    actor_id: user,
    note: null,
    after: { reasonCode: spec.reason },
    created_at: iso(daysAgo(now, spec.createdDay, 11)),
  };
  const history = spec.steps.reduce<ReadonlyArray<HistoryRow>>((rows, step, i) => {
    const prev = rows[rows.length - 1];
    const actor = actorOf(step.action);
    return [
      ...rows,
      {
        dispute_id: id,
        seq: i + 1,
        action: step.action,
        from_status: prev?.to_status ?? 'SUBMITTED',
        to_status: step.to,
        actor_type: actor.type,
        actor_id: actor.id,
        note: step.note ?? null,
        after: null,
        created_at: iso(daysAgo(now, step.day, 13)),
      },
    ];
  }, [created]);
  const last = history[history.length - 1] ?? created;
  const lastActor = actorOf(last.action);
  const resolved = last.action === 'RESOLVE';
  return {
    dispute: {
      dispute_id: id,
      transaction_id: transactionId(spec.txnKey),
      user_id: user,
      reason_code: spec.reason,
      description: spec.description,
      status: last.to_status,
      version: history.length,
      resolved_at: resolved ? last.created_at : null,
      resolution_note: resolved ? last.note : null,
      created_by: `USER:${user}`,
      updated_by: last.action === 'CREATE' ? `USER:${user}` : `${lastActor.type}:${lastActor.id}`,
      created_at: created.created_at,
      updated_at: last.created_at,
    },
    history,
  };
};

export type GenerateOptions = { readonly seed: number; readonly now: Date };

export const generateSeedData = ({ seed, now }: GenerateOptions): SeedData => {
  const r = createRng(seed);
  const active = PERSONAS.filter((p) => !p.disabled);
  const disputes = DISPUTE_SPECS.map((spec) => disputeRows(now, spec));
  return {
    appUsers: PERSONAS.map(appUserRow),
    authIdentities: PERSONAS.map(authIdentityRow),
    accounts: PERSONAS.flatMap((p) => p.accounts.map((a) => accountRow(r, p, a))),
    cards: PERSONAS.flatMap((p) => p.accounts.flatMap((a) => a.cards.map((c) => cardRow(r, now, a, c)))),
    transactions: [
      ...active.flatMap((p) =>
        Array.from({ length: RANDOM_TXNS_PER_USER }, (_, i) => randomTransaction(r, now, p, cardRefs(p), i)),
      ),
      ...specialTransactions(now),
    ],
    disputes: disputes.map((d) => d.dispute),
    history: disputes.flatMap((d) => d.history),
  };
};
