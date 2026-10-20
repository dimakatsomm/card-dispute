import { isStaleEvent, type DisputeEvent } from '@cd/dispute-domain';

export type DisputeVersion = {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly version: number;
};

export type Delivery =
  | { readonly kind: 'SEND' }
  | { readonly kind: 'SKIP_STALE'; readonly currentVersion: number }
  | { readonly kind: 'DISPUTE_ABSENT' };

// The lookup is scoped to event.userId, so a match also proves the event's user owns the dispute.
export const decideDelivery = (event: DisputeEvent, owned: ReadonlyArray<DisputeVersion>): Delivery => {
  const current = owned.find((d) => d.disputeId === event.disputeId && d.transactionId === event.transactionId);
  if (!current) return { kind: 'DISPUTE_ABSENT' };
  return isStaleEvent(event, current.version)
    ? { kind: 'SKIP_STALE', currentVersion: current.version }
    : { kind: 'SEND' };
};
