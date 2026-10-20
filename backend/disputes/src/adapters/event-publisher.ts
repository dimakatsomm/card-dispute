import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { err, ok, type Result } from '@cd/shared/fp';
import type { FastifyBaseLogger } from 'fastify';
import type { DisputeEvent } from '../core/types.ts';
import type { PublishEvent } from '../use-cases/ports.ts';
import { summarizeError, withDeadline } from './deadline.ts';

export type QueueMessage = {
  readonly queueUrl: string;
  readonly body: string;
  readonly correlationId: string;
};

export type SendMessage = (message: QueueMessage) => Promise<void>;

export const SQS_REQUEST_TIMEOUT_MS = 1000;

export const createSqsSend = (options: {
  readonly region: string;
  readonly endpoint?: string;
}): SendMessage => {
  const client = new SQSClient({
    region: options.region,
    // The publisher owns retries under one budget; SDK retries would multiply it.
    maxAttempts: 1,
    requestHandler: { requestTimeout: SQS_REQUEST_TIMEOUT_MS, connectionTimeout: SQS_REQUEST_TIMEOUT_MS },
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });
  return async (message) => {
    await client.send(
      new SendMessageCommand({
        QueueUrl: message.queueUrl,
        MessageBody: message.body,
        MessageAttributes: { 'x-correlation-id': { DataType: 'String', StringValue: message.correlationId } },
      }),
    );
  };
};

export type EventPublisherDeps = {
  readonly send: SendMessage;
  readonly queueUrl: string;
  readonly log: FastifyBaseLogger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly budgetMs?: number;
};

export const PUBLISH_BUDGET_MS = 1500;

// CloudWatch embedded metric format: the log line itself becomes the EventPublishFailed metric (docs/01).
const publishFailedMetric = (timestamp: number) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: 'cd/disputes',
        Dimensions: [['eventType']],
        Metrics: [{ Name: 'EventPublishFailed', Unit: 'Count' }],
      },
    ],
  },
  EventPublishFailed: 1,
});

const budgetExceeded = (ms: number) =>
  Object.assign(new Error(`publish budget of ${ms}ms exceeded`), { name: 'TimeoutError' });

export const createEventPublisher = (deps: EventPublisherDeps): PublishEvent => {
  const attempts = deps.attempts ?? 3;
  const baseDelayMs = deps.baseDelayMs ?? 100;
  const budgetMs = deps.budgetMs ?? PUBLISH_BUDGET_MS;

  const sendOnce = async (message: QueueMessage): Promise<Result<true, unknown>> => {
    try {
      await deps.send(message);
      return ok(true);
    } catch (error) {
      return err(error);
    }
  };

  const attempt = async (
    message: QueueMessage,
    n: number,
    deadlineAt: number,
  ): Promise<Result<true, unknown>> => {
    const sent = await withDeadline(deadlineAt - deps.now().getTime(), sendOnce(message), () =>
      err(budgetExceeded(budgetMs)),
    );
    if (sent.ok || n >= attempts) return sent;
    const delay = baseDelayMs * 2 ** (n - 1);
    if (deps.now().getTime() + delay >= deadlineAt) return sent;
    await deps.sleep(delay);
    return attempt(message, n + 1, deadlineAt);
  };

  // Best-effort after commit (ADR-023): never throws and is bounded, so a lost event never fails or stalls the request.
  return async (event: DisputeEvent, correlationId: string) => {
    const message = { queueUrl: deps.queueUrl, body: JSON.stringify(event), correlationId };
    const sent = await attempt(message, 1, deps.now().getTime() + budgetMs);
    if (sent.ok) return;
    deps.log.error(
      {
        ...publishFailedMetric(deps.now().getTime()),
        eventType: event.eventType,
        eventId: event.eventId,
        disputeId: event.disputeId,
        error: summarizeError(sent.error),
      },
      'event publish failed',
    );
  };
};
