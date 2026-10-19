import { describe, expect, it } from 'vitest';
import {
  cardId,
  DEFAULT_SEED,
  EXPIRED_CARD_KEY,
  generateSeedData,
  SPECIAL_TXN,
  transactionId,
  userId,
  type TransactionRow,
} from '../src/generate.ts';

const NOW = new Date('2026-10-19T09:30:00Z');
const data = generateSeedData({ seed: DEFAULT_SEED, now: NOW });

const DAY_MS = 86_400_000;
const utcMidnight = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const wholeUtcDaysAgo = (iso: string): number => (utcMidnight(NOW) - utcMidnight(new Date(iso))) / DAY_MS;

const txn = (key: string): TransactionRow => {
  const row = data.transactions.find((t) => t.transaction_id === transactionId(key));
  if (row === undefined) throw new Error(`missing special transaction ${key}`);
  return row;
};

describe('generateSeedData', () => {
  it('is deterministic: the same seed and clock produce identical data, another seed does not', () => {
    expect(generateSeedData({ seed: DEFAULT_SEED, now: NOW })).toEqual(data);
    const other = generateSeedData({ seed: DEFAULT_SEED + 1, now: NOW });
    expect(other.transactions.map((t) => t.amount)).not.toEqual(data.transactions.map((t) => t.amount));
  });

  it('gives A, B and C 1-2 accounts, 1-2 cards per account and ~200 transactions within 180 days', () => {
    for (const key of ['A', 'B', 'C'] as const) {
      const accounts = data.accounts.filter((a) => a.user_id === userId(key));
      expect(accounts.length).toBeGreaterThanOrEqual(1);
      expect(accounts.length).toBeLessThanOrEqual(2);
      for (const account of accounts) {
        const cards = data.cards.filter((c) => c.account_id === account.account_id);
        expect(cards.length).toBeGreaterThanOrEqual(1);
        expect(cards.length).toBeLessThanOrEqual(2);
      }
      const txns = data.transactions.filter((t) => t.user_id === userId(key));
      expect(txns.length).toBeGreaterThanOrEqual(200);
      expect(txns.length).toBeLessThanOrEqual(220);
      expect(txns.every((t) => wholeUtcDaysAgo(t.transaction_at) >= 1 && wholeUtcDaysAgo(t.transaction_at) <= 180)).toBe(true);
    }
    expect(new Set(data.transactions.map((t) => t.transaction_id)).size).toBe(data.transactions.length);
  });

  it("links every transaction's card to its account and that account to the transaction's user", () => {
    const accountOwner = new Map(data.accounts.map((a) => [a.account_id, a.user_id]));
    const cardAccount = new Map(data.cards.map((c) => [c.card_id, c.account_id]));
    for (const t of data.transactions) {
      expect(cardAccount.get(t.card_id)).toBe(t.account_id);
      expect(accountOwner.get(t.account_id)).toBe(t.user_id);
    }
  });

  it("includes A's boundary cases: POSTED at 119 and 121 days, PENDING, DECLINED, REFUND", () => {
    const a = userId('A');
    const p119 = txn(SPECIAL_TXN.posted119);
    const p121 = txn(SPECIAL_TXN.posted121);
    expect([p119.status, p119.type, p119.user_id]).toEqual(['POSTED', 'PURCHASE', a]);
    expect(wholeUtcDaysAgo(p119.posted_at ?? '')).toBe(119);
    expect([p121.status, p121.type, p121.user_id]).toEqual(['POSTED', 'PURCHASE', a]);
    expect(wholeUtcDaysAgo(p121.posted_at ?? '')).toBe(121);
    expect(txn(SPECIAL_TXN.pending)).toMatchObject({ status: 'PENDING', posted_at: null, user_id: a });
    expect(txn(SPECIAL_TXN.declined)).toMatchObject({ status: 'DECLINED', posted_at: null, user_id: a });
    expect(txn(SPECIAL_TXN.refund)).toMatchObject({ status: 'POSTED', type: 'REFUND', user_id: a });
  });

  it('includes a duplicate pair for A: same merchant and amount within 48h', () => {
    const [first, second] = [txn(SPECIAL_TXN.duplicate1), txn(SPECIAL_TXN.duplicate2)];
    expect(second.merchant_name).toBe(first.merchant_name);
    expect(second.amount).toBe(first.amount);
    expect(second.card_id).toBe(first.card_id);
    const gapMs = Math.abs(Date.parse(second.transaction_at) - Date.parse(first.transaction_at));
    expect(gapMs).toBeGreaterThan(0);
    expect(gapMs).toBeLessThanOrEqual(48 * 3_600_000);
  });

  it('gives A an ACTIVE-status card that expired last month, with recent POSTED transactions', () => {
    const expired = data.cards.find((c) => c.card_id === cardId(EXPIRED_CARD_KEY));
    expect(expired).toMatchObject({ expiry_month: 9, expiry_year: 2026 });
    const recent = data.transactions.filter(
      (t) => t.card_id === cardId(EXPIRED_CARD_KEY) && t.status === 'POSTED' && wholeUtcDaysAgo(t.posted_at ?? '') <= 30,
    );
    expect(recent.length).toBeGreaterThanOrEqual(3);
    const others = data.cards.filter((c) => c.card_id !== cardId(EXPIRED_CARD_KEY));
    expect(others.every((c) => c.expiry_year > 2026)).toBe(true);
  });

  it('wraps the expired card into December of the previous year when seeded in January', () => {
    const jan = generateSeedData({ seed: DEFAULT_SEED, now: new Date('2027-01-05T12:00:00Z') });
    expect(jan.cards.find((c) => c.card_id === cardId(EXPIRED_CARD_KEY))).toMatchObject({ expiry_month: 12, expiry_year: 2026 });
  });

  it("seeds A's disputes in UNDER_REVIEW, RESOLVED_ACCEPTED (with note), RESOLVED_REJECTED and WITHDRAWN with consistent history", () => {
    const byStatus = new Map(data.disputes.map((d) => [d.status, d]));
    expect([...byStatus.keys()].sort()).toEqual(['RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'UNDER_REVIEW', 'WITHDRAWN']);
    expect(byStatus.get('RESOLVED_ACCEPTED')?.resolution_note).toBeTruthy();
    expect(new Set(data.disputes.map((d) => d.transaction_id)).size).toBe(data.disputes.length);

    const expectedActions = {
      UNDER_REVIEW: ['CREATE', 'REVIEW'],
      RESOLVED_ACCEPTED: ['CREATE', 'REVIEW', 'RESOLVE'],
      RESOLVED_REJECTED: ['CREATE', 'REVIEW', 'RESOLVE'],
      WITHDRAWN: ['CREATE', 'WITHDRAW'],
    } as const;
    for (const d of data.disputes) {
      const t = data.transactions.find((x) => x.transaction_id === d.transaction_id);
      expect(t).toMatchObject({ user_id: userId('A'), status: 'POSTED', type: 'PURCHASE' });
      expect(d.user_id).toBe(userId('A'));
      expect(t?.card_id).not.toBe(cardId(EXPIRED_CARD_KEY));

      const history = data.history.filter((h) => h.dispute_id === d.dispute_id);
      expect(history.map((h) => h.action)).toEqual(expectedActions[d.status as keyof typeof expectedActions]);
      expect(history[0]).toMatchObject({ from_status: null, to_status: 'SUBMITTED', actor_type: 'USER' });
      history.slice(1).forEach((h, i) => expect(h.from_status).toBe(history[i]?.to_status));
      expect(history.at(-1)?.to_status).toBe(d.status);
      expect(d.version).toBe(history.length);
      expect(history.map((h) => h.created_at)).toEqual([...history.map((h) => h.created_at)].sort());
      expect(Date.parse(history[0]?.created_at ?? '')).toBeGreaterThan(Date.parse(t?.posted_at ?? ''));
      expect(d.resolved_at !== null).toBe(d.status.startsWith('RESOLVED_'));
      for (const h of history) {
        expect(h.actor_type).toBe(h.action === 'REVIEW' || h.action === 'RESOLVE' ? 'AGENT' : 'USER');
      }
    }
  });

  it('marks D DISABLED in auth (and CLOSED in users) with no accounts', () => {
    expect(data.authIdentities.find((i) => i.username === 'dumisani.zulu')).toMatchObject({
      cognito_sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      status: 'DISABLED',
    });
    expect(data.appUsers.find((u) => u.user_id === userId('D'))?.status).toBe('CLOSED');
    expect(data.accounts.some((a) => a.user_id === userId('D'))).toBe(false);
    expect(data.authIdentities.filter((i) => i.status === 'ACTIVE').map((i) => i.cognito_sub)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
  });

  it('uses only example.com emails and ZAR', () => {
    expect(data.appUsers.every((u) => u.email.endsWith('@example.com'))).toBe(true);
    expect([...data.accounts, ...data.transactions].every((r) => r.currency === 'ZAR')).toBe(true);
  });
});
