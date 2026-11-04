import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import { err, ok } from '@cd/shared/fp';
import type { SendEmail, SendFailure } from '../use-cases/ports.ts';

export type SesSenderDeps = { readonly client: Pick<SESv2Client, 'send'>; readonly sender: string };

// Refusals tied to this recipient or message: a retry gets the same answer, so the message is acknowledged.
const UNDELIVERABLE = new Set(['MessageRejected', 'BadRequestException']);
// Account or IAM faults go to the DLQ so they stay visible and can be redriven once fixed.
const REJECTED = new Set([
  'AccessDeniedException',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
]);
const THROTTLED = new Set(['TooManyRequestsException', 'ThrottlingException', 'LimitExceededException']);

export const classifySesError = (name: string): SendFailure['kind'] => {
  if (UNDELIVERABLE.has(name)) return 'undeliverable';
  if (REJECTED.has(name)) return 'rejected';
  return THROTTLED.has(name) ? 'throttled' : 'unavailable';
};

const utf8 = (Data: string) => ({ Data, Charset: 'UTF-8' });

// Only the error name leaves this adapter: SES messages can echo the recipient address.
export const createSesSender =
  ({ client, sender }: SesSenderDeps): SendEmail =>
  async (email) => {
    try {
      const out = await client.send(
        new SendEmailCommand({
          FromEmailAddress: sender,
          Destination: { ToAddresses: [email.to] },
          Content: {
            Simple: { Subject: utf8(email.subject), Body: { Text: utf8(email.text), Html: utf8(email.html) } },
          },
        }),
      );
      return ok({ messageId: out.MessageId ?? '' });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      return err({ kind: classifySesError(errorName), errorName });
    }
  };
