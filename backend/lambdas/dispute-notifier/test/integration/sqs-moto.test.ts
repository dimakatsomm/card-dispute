import { randomUUID } from 'node:crypto';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { SqsHandler } from '../../src/handler.ts';
import { EMAIL_A, setup, statusEvent } from '../support.ts';

// moto comes from test/moto-global-setup.ts; the redrive check mirrors orchestration/verify-m2-00.md.
const ENDPOINT = inject('motoEndpoint');
const MAX_RECEIVE_COUNT = 5;

const sqs = new SQSClient({
  endpoint: ENDPOINT,
  region: 'eu-north-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const ses = mockClient(SESv2Client);

type QueuePair = { readonly queueUrl: string; readonly dlqUrl: string };

const createQueuePair = async (): Promise<QueuePair> => {
  const suffix = randomUUID().slice(0, 8);
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `dispute-notifications-dlq-${suffix}` }));
  const dlqUrl = dlq.QueueUrl ?? '';
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `dispute-notifications-${suffix}`,
      Attributes: {
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes?.['QueueArn'],
          maxReceiveCount: MAX_RECEIVE_COUNT,
        }),
      },
    }),
  );
  return { queueUrl: queue.QueueUrl ?? '', dlqUrl };
};

const receive = async (queueUrl: string, waitSeconds: number): Promise<ReadonlyArray<Message>> => {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return out.Messages ?? [];
};

// Event-source-mapping semantics: invoke with the batch, delete only what the handler did not report.
const pollOnce = async (handler: SqsHandler, queueUrl: string, waitSeconds = 3) => {
  const messages = await receive(queueUrl, waitSeconds);
  if (messages.length === 0) return { messages, failed: [] as string[] };
  const res = await handler({
    Records: messages.map((m) => ({ messageId: m.MessageId, body: m.Body, receiptHandle: m.ReceiptHandle })),
  });
  const failed = res.batchItemFailures.map((f) => f.itemIdentifier);
  const done = messages.filter((m) => !failed.includes(m.MessageId ?? ''));
  if (done.length > 0) {
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return { messages, failed };
};

const sentTo = () => ses.commandCalls(SendEmailCommand).map((c) => c.args[0].input.Destination?.ToAddresses);

describe('dispute-notifier on SQS (moto)', () => {
  let pair: QueuePair;

  beforeEach(async () => {
    ses.reset();
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
    pair = await createQueuePair();
  });

  afterEach(async () => {
    ses.reset();
    await sqs.send(new DeleteQueueCommand({ QueueUrl: pair.queueUrl }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: pair.dlqUrl }));
  });

  it('happy path: one email to the owner and the message is deleted', async () => {
    const { handler } = setup();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: pair.queueUrl,
        MessageBody: JSON.stringify(statusEvent('DisputeStatusChanged', 'UNDER_REVIEW', 3)),
      }),
    );
    const first = await pollOnce(handler, pair.queueUrl);
    expect(first.messages).toHaveLength(1);
    expect(first.failed).toEqual([]);
    expect(sentTo()).toEqual([[EMAIL_A]]);
    expect(await receive(pair.queueUrl, 2)).toEqual([]);
  });

  it('duplicate delivery: both copies succeed and are deleted (a second email is accepted)', async () => {
    const { handler } = setup();
    const body = JSON.stringify(statusEvent('DisputeStatusChanged', 'RESOLVED_ACCEPTED', 3));
    await sqs.send(new SendMessageCommand({ QueueUrl: pair.queueUrl, MessageBody: body }));
    await sqs.send(new SendMessageCommand({ QueueUrl: pair.queueUrl, MessageBody: body }));
    const handled: string[] = [];
    for (let i = 0; i < 4 && handled.length < 2; i += 1) {
      const { messages, failed } = await pollOnce(handler, pair.queueUrl, 1);
      expect(failed).toEqual([]);
      handled.push(...messages.map((m) => m.MessageId ?? ''));
    }
    expect(handled).toHaveLength(2);
    expect(sentTo()).toEqual([[EMAIL_A], [EMAIL_A]]);
    expect(await receive(pair.queueUrl, 2)).toEqual([]);
  });

  it(`poison: received ${MAX_RECEIVE_COUNT} times, never emailed, then lands in dispute-notifications-dlq`, async () => {
    const { handler } = setup();
    const poison = '{"eventType":"DisputeStatusChanged","email":"victim@example.com"}';
    await sqs.send(new SendMessageCommand({ QueueUrl: pair.queueUrl, MessageBody: poison }));

    const receiveCounts: string[] = [];
    while (receiveCounts.length < MAX_RECEIVE_COUNT) {
      const { messages, failed } = await pollOnce(handler, pair.queueUrl);
      expect(messages).toHaveLength(1);
      expect(failed).toEqual([messages[0]?.MessageId]);
      receiveCounts.push(messages[0]?.Attributes?.['ApproximateReceiveCount'] ?? '?');
    }
    expect(receiveCounts).toEqual(['1', '2', '3', '4', '5']);

    expect(await receive(pair.queueUrl, 3)).toEqual([]);
    const dead = await receive(pair.dlqUrl, 3);
    expect(dead.map((m) => m.Body)).toEqual([poison]);
    expect(sentTo()).toEqual([]);
  });
});
