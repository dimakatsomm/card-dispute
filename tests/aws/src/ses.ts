import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { sqs } from './aws.ts';
import { env } from './env.ts';
import { until } from './poll.ts';

const SesEvent = z.object({
  detail: z.object({
    eventType: z.string(),
    mail: z.object({
      timestamp: z.string(),
      destination: z.array(z.string()),
      commonHeaders: z.object({ subject: z.string().optional() }).optional(),
    }),
  }),
});

export type SesEventRecord = {
  readonly type: string;
  readonly at: number;
  readonly to: readonly string[];
  readonly subject: string | undefined;
};

const seen: SesEventRecord[] = [];

// The queue exists for these checks only, so every received message is deleted after it is recorded.
const drain = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    const out = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: env().sesEventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) return;
    for (const message of messages) {
      try {
        let raw: unknown;
        try {
          raw = JSON.parse(message.Body ?? '');
        } catch {
          throw new Error('ses event malformed');
        }
        const parsed = SesEvent.safeParse(raw);
        if (!parsed.success) throw new Error('ses event malformed');
        const { eventType, mail } = parsed.data.detail;
        seen.push({
          type: eventType,
          at: Date.parse(mail.timestamp),
          to: mail.destination,
          subject: mail.commonHeaders?.subject,
        });
      } finally {
        await sqs().send(
          new DeleteMessageCommand({
            QueueUrl: env().sesEventsQueueUrl,
            ReceiptHandle: message.ReceiptHandle ?? '',
          }),
        );
      }
    }
  }
};

export const eventsSince = (sinceMs: number): readonly SesEventRecord[] =>
  seen.filter((event) => event.at >= sinceMs);

export const awaitDelivery = (
  subject: string,
  to: string,
  sinceMs: number,
  timeoutMs: number,
): Promise<SesEventRecord> =>
  until(
    `SES Delivery "${subject}" to the owner`,
    async () => {
      await drain();
      return eventsSince(sinceMs).find(
        (event) => event.type === 'Delivery' && event.subject === subject && event.to.includes(to),
      );
    },
    timeoutMs,
    5_000,
  );
