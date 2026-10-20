import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import type { Invoke } from './rie.ts';

export type PollerDeps = {
  readonly sqs: SQSClient;
  readonly invoke: Invoke;
  readonly queueUrl: string;
  readonly queueArn: string;
  readonly region: string;
  readonly notifierUrl: string;
  readonly waitSeconds: number;
};

const responseSchema = z
  .object({ batchItemFailures: z.array(z.object({ itemIdentifier: z.string() })).default([]) })
  .nullable();

const toRecord = (deps: PollerDeps, message: Message) => ({
  messageId: message.MessageId,
  receiptHandle: message.ReceiptHandle,
  body: message.Body,
  attributes: {
    ApproximateReceiveCount: message.Attributes?.['ApproximateReceiveCount'] ?? '1',
    SentTimestamp: message.Attributes?.['SentTimestamp'] ?? '',
    SenderId: message.Attributes?.['SenderId'] ?? '',
    ApproximateFirstReceiveTimestamp: message.Attributes?.['ApproximateFirstReceiveTimestamp'] ?? '',
  },
  messageAttributes: {},
  md5OfBody: message.MD5OfBody,
  eventSource: 'aws:sqs',
  eventSourceARN: deps.queueArn,
  awsRegion: deps.region,
});

// Returns the number of records deleted.
export const pollOnce = async (deps: PollerDeps): Promise<number> => {
  const { Messages = [] } = await deps.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: deps.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: deps.waitSeconds,
      MessageSystemAttributeNames: ['All'],
    }),
  );
  if (Messages.length === 0) return 0;

  const result = await deps.invoke(deps.notifierUrl, { Records: Messages.map((m) => toRecord(deps, m)) });
  if (!result.ok) {
    console.warn(`sqs-poller: invocation failed, batch of ${Messages.length} left for redelivery: ${result.reason}`);
    return 0;
  }
  const parsed = responseSchema.safeParse(result.payload);
  if (!parsed.success) {
    console.warn('sqs-poller: unreadable function response, batch left for redelivery');
    return 0;
  }
  const failed = new Set((parsed.data?.batchItemFailures ?? []).map((f) => f.itemIdentifier));
  const done = Messages.filter((m) => m.MessageId !== undefined && !failed.has(m.MessageId));
  await Promise.all(
    done.map((m) =>
      deps.sqs.send(new DeleteMessageCommand({ QueueUrl: deps.queueUrl, ReceiptHandle: m.ReceiptHandle })),
    ),
  );
  return done.length;
};
