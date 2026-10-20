import { parseDisputeEvent, type DisputeEvent, type EventType } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { decideDelivery } from '../core/delivery.ts';
import { renderEmail } from '../core/templates.ts';
import type { FetchContact, LookupDisputes, SendEmail, SendFailure } from './ports.ts';

export type NotifyDeps = {
  readonly lookupDisputes: LookupDisputes;
  readonly fetchContact: FetchContact;
  readonly sendEmail: SendEmail;
};

export type QueueRecord = { readonly messageId: string; readonly body: string };

export type EventRef = { readonly eventId: string; readonly eventType: EventType; readonly disputeId: string };

export type NotifyOutcome =
  | { readonly kind: 'SENT'; readonly ref: EventRef; readonly sesMessageId: string }
  | { readonly kind: 'SKIPPED_STALE'; readonly ref: EventRef; readonly eventVersion: number; readonly currentVersion: number };

export type NotifyFailure =
  | { readonly kind: 'INVALID_MESSAGE'; readonly issues: ReadonlyArray<string> }
  | {
      readonly kind:
        | 'DISPUTE_LOOKUP_FAILED'
        | 'DISPUTE_NOT_FOUND'
        | 'CONTACT_NOT_FOUND'
        | 'CONTACT_LOOKUP_FAILED'
        | 'CONTACT_MISMATCH';
      readonly ref: EventRef;
    }
  | { readonly kind: 'EMAIL_REJECTED' | 'EMAIL_THROTTLED' | 'EMAIL_FAILED'; readonly ref: EventRef; readonly errorName: string };

const parseJson = (body: string): Result<unknown, NotifyFailure> => {
  try {
    return ok(JSON.parse(body) as unknown);
  } catch {
    return err({ kind: 'INVALID_MESSAGE', issues: ['(root): invalid_json'] });
  }
};

const parseBody = (body: string): Result<DisputeEvent, NotifyFailure> => {
  const json = parseJson(body);
  if (!json.ok) return json;
  const event = parseDisputeEvent(json.value);
  return event.ok ? event : err({ kind: 'INVALID_MESSAGE', issues: event.error.issues });
};

const EMAIL_FAILURE: Readonly<Record<SendFailure['kind'], 'EMAIL_REJECTED' | 'EMAIL_THROTTLED' | 'EMAIL_FAILED'>> = {
  rejected: 'EMAIL_REJECTED',
  throttled: 'EMAIL_THROTTLED',
  unavailable: 'EMAIL_FAILED',
};

// Every doubt (lookup failure, absent dispute, unknown contact) is a failure: the record retries, then reaches the DLQ.
export const notifyCustomer =
  (deps: NotifyDeps) =>
  async (record: QueueRecord): Promise<Result<NotifyOutcome, NotifyFailure>> => {
    const parsed = parseBody(record.body);
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    const ref: EventRef = { eventId: event.eventId, eventType: event.eventType, disputeId: event.disputeId };
    const correlationId = event.eventId;

    const owned = await deps.lookupDisputes(event.userId, event.transactionId, correlationId);
    if (!owned.ok) return err({ kind: 'DISPUTE_LOOKUP_FAILED', ref });
    const delivery = decideDelivery(event, owned.value);
    if (delivery.kind === 'DISPUTE_ABSENT') return err({ kind: 'DISPUTE_NOT_FOUND', ref });
    if (delivery.kind === 'SKIP_STALE') {
      return ok({ kind: 'SKIPPED_STALE', ref, eventVersion: event.version, currentVersion: delivery.currentVersion });
    }

    const contact = await deps.fetchContact(event.userId, correlationId);
    if (!contact.ok) {
      return err({ kind: contact.error.kind === 'not_found' ? 'CONTACT_NOT_FOUND' : 'CONTACT_LOOKUP_FAILED', ref });
    }
    if (contact.value.userId !== event.userId) return err({ kind: 'CONTACT_MISMATCH', ref });

    const sent = await deps.sendEmail({ to: contact.value.email, ...renderEmail(event, contact.value.name) });
    if (!sent.ok) return err({ kind: EMAIL_FAILURE[sent.error.kind], ref, errorName: sent.error.errorName });
    return ok({ kind: 'SENT', ref, sesMessageId: sent.value.messageId });
  };
