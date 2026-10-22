import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { sqs } from '../src/aws.ts';
import { env } from '../src/env.ts';

// Runs as a second vitest invocation (see the test:aws script) so every other suite has finished first.
describe('after the run', () => {
  it('no DLQ holds a message left behind by the suites', async () => {
    const p = env().namePrefix;
    const base = env().notificationsQueueUrl;
    const names = [
      `${p}-dispute-notifications-dlq`,
      `${p}-evidence-intake-dlq`,
      `${p}-retention-scheduler-dlq`,
    ];
    for (const name of names) {
      const out = await sqs().send(
        new GetQueueAttributesCommand({
          QueueUrl: base.replace(/[^/]+$/, name),
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      const waiting =
        Number(out.Attributes?.['ApproximateNumberOfMessages']) +
        Number(out.Attributes?.['ApproximateNumberOfMessagesNotVisible']);
      expect(waiting, `${name} depth`).toBe(0);
    }
  });
});
