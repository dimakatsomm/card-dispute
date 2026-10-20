import type { Result } from '@cd/shared/fp';
import { z } from 'zod';
import type { NotifyFailure, NotifyOutcome, QueueRecord } from './use-cases/notify-customer.ts';
import type { Log } from './use-cases/ports.ts';

export type SqsBatchResponse = { readonly batchItemFailures: ReadonlyArray<{ readonly itemIdentifier: string }> };
export type SqsHandler = (event: unknown) => Promise<SqsBatchResponse>;
export type Notify = (record: QueueRecord) => Promise<Result<NotifyOutcome, NotifyFailure>>;

const sqsEventSchema = z.object({
  Records: z.array(z.looseObject({ messageId: z.string().min(1), body: z.string() })),
});

const parseRecords = (event: unknown): ReadonlyArray<QueueRecord> => {
  const parsed = sqsEventSchema.safeParse(event);
  // Without message ids no partial response is possible, so the whole batch goes back to the queue.
  if (!parsed.success) throw new Error('event is not an SQS batch');
  return parsed.data.Records.map(({ messageId, body }) => ({ messageId, body }));
};

const failAll = (records: ReadonlyArray<QueueRecord>): SqsBatchResponse => ({
  batchItemFailures: records.map((r) => ({ itemIdentifier: r.messageId })),
});

const handleRecord = async (notify: Notify, log: Log, record: QueueRecord): Promise<boolean> => {
  const { messageId } = record;
  const result = await notify(record).catch((error: unknown) => {
    log.error({ messageId, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'notification crashed');
    return undefined;
  });
  if (!result) return false;
  if (result.ok) {
    const { ref, ...outcome } = result.value;
    log.info({ messageId, ...ref, ...outcome }, 'notification handled');
    return true;
  }
  log.warn({ messageId, ...result.error }, 'notification failed');
  return false;
};

export const createHandler =
  ({ notify, log }: { readonly notify: Notify; readonly log: Log }): SqsHandler =>
  async (event) => {
    const records = parseRecords(event);
    const failed: QueueRecord[] = [];
    for (const record of records) {
      if (!(await handleRecord(notify, log, record))) failed.push(record);
    }
    return failAll(failed);
  };

// Init (config, secret) runs on the first batch; a failed init returns the batch and is retried on the next one.
export const createLazyHandler = ({
  init,
  log,
}: {
  readonly init: () => Promise<Result<SqsHandler, string>>;
  readonly log: Log;
}): SqsHandler => {
  let ready: Promise<Result<SqsHandler, string>> | undefined;
  return async (event) => {
    ready ??= init();
    const handler = await ready;
    if (handler.ok) return handler.value(event);
    ready = undefined;
    log.error({ detail: handler.error }, 'notifier initialisation failed; returning the batch');
    return failAll(parseRecords(event));
  };
};
