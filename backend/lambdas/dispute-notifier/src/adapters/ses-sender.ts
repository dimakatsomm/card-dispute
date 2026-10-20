import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import { err, ok } from '@cd/shared/fp';
import type { SendEmail, SendFailure } from '../use-cases/ports.ts';

export type SesSenderDeps = { readonly client: Pick<SESv2Client, 'send'>; readonly sender: string };

const REJECTED = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException']);
const THROTTLED = new Set(['TooManyRequestsException', 'ThrottlingException', 'LimitExceededException']);

const classify = (name: string): SendFailure['kind'] =>
  REJECTED.has(name) ? 'rejected' : THROTTLED.has(name) ? 'throttled' : 'unavailable';

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
      return err({ kind: classify(errorName), errorName });
    }
  };
