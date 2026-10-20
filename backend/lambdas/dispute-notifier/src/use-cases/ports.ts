import type { DisputeStatus } from '@cd/dispute-domain';
import type { Result } from '@cd/shared/fp';
import type { EmailContent } from '../core/templates.ts';

export type UpstreamFailure = { readonly kind: 'not_found' | 'unavailable' };

export type Contact = { readonly userId: string; readonly email: string; readonly name: string };

export type OwnedDispute = {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly status: DisputeStatus;
  readonly version: number;
};

export type FetchContact = (userId: string, correlationId: string) => Promise<Result<Contact, UpstreamFailure>>;

export type LookupDisputes = (
  userId: string,
  transactionId: string,
  correlationId: string,
) => Promise<Result<ReadonlyArray<OwnedDispute>, UpstreamFailure>>;

export type OutgoingEmail = EmailContent & { readonly to: string };

export type SendFailure = { readonly kind: 'rejected' | 'throttled' | 'unavailable'; readonly errorName: string };

export type SendEmail = (email: OutgoingEmail) => Promise<Result<{ readonly messageId: string }, SendFailure>>;

export type Log = {
  readonly info: (obj: object, msg?: string) => void;
  readonly warn: (obj: object, msg?: string) => void;
  readonly error: (obj: object, msg?: string) => void;
};
