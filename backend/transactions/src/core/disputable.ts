import {
  evaluateTransactionEligibility,
  type DisputeStatus,
  type EligibilityCard,
  type EligibilityReason,
} from '@cd/dispute-domain';
import type { Transaction } from './transaction.ts';

export type DisputableReason = EligibilityReason | 'UNAVAILABLE';

export type Disputable = { readonly allowed: true } | { readonly allowed: false; readonly reason: DisputableReason };

export type DisputeRef = { readonly transactionId: string; readonly disputeId: string; readonly status: DisputeStatus };

export type CardRef = EligibilityCard & { readonly cardId: string };

export type UpstreamError = { readonly service: 'users' | 'disputes'; readonly detail: string };

export type Enrichment = {
  readonly cards: ReadonlyArray<CardRef>;
  readonly disputes: ReadonlyArray<DisputeRef>;
};

export type EnrichedTransaction = Transaction & {
  readonly dispute: { readonly disputeId: string; readonly status: DisputeStatus } | null;
  readonly disputable: Disputable;
};

const UNAVAILABLE: Disputable = { allowed: false, reason: 'UNAVAILABLE' };

// Invalid expiry: the domain treats it as expired, so a placeholder can never yield allowed.
const UNKNOWN_CARD: EligibilityCard = { expiryMonth: 0, expiryYear: 0, status: 'ACTIVE' };

const decide = (txn: Transaction, card: CardRef | undefined, dispute: DisputeRef | undefined, now: Date): Disputable => {
  const result = evaluateTransactionEligibility(
    { type: txn.type, status: txn.status, postedAt: txn.postedAt === null ? null : new Date(txn.postedAt) },
    card ?? UNKNOWN_CARD,
    dispute ?? null,
    now,
  );
  // Without the card only reasons the domain ranks before the card check (ALREADY_DISPUTED) are trustworthy.
  if (card === undefined && (result.ok || result.error !== 'ALREADY_DISPUTED')) return UNAVAILABLE;
  return result.ok ? { allowed: true } : { allowed: false, reason: result.error };
};

export const enrich = (
  rows: ReadonlyArray<Transaction>,
  enrichment: Enrichment | null,
  now: Date,
): ReadonlyArray<EnrichedTransaction> => {
  if (enrichment === null) return rows.map((row) => ({ ...row, dispute: null, disputable: UNAVAILABLE }));
  const cards = new Map(enrichment.cards.map((c) => [c.cardId, c]));
  const disputes = new Map(enrichment.disputes.map((d) => [d.transactionId, d]));
  return rows.map((row) => {
    const dispute = disputes.get(row.transactionId);
    return {
      ...row,
      dispute: dispute === undefined ? null : { disputeId: dispute.disputeId, status: dispute.status },
      disputable: decide(row, cards.get(row.cardId), dispute, now),
    };
  });
};
