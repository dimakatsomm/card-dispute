import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { cloudwatch, sqs } from '../src/aws.ts';
import { env } from '../src/env.ts';

const sibling = (queueUrl: string, name: string): string => queueUrl.replace(/[^/]+$/, name);

const attributes = async (queueUrl: string): Promise<Record<string, string>> =>
  (await sqs().send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] })))
    .Attributes ?? {};

describe('queues and redrive', () => {
  const p = env().namePrefix;
  const dlqs = {
    notifications: sibling(env().notificationsQueueUrl, `${p}-dispute-notifications-dlq`),
    evidenceIntake: sibling(env().notificationsQueueUrl, `${p}-evidence-intake-dlq`),
    retentionScheduler: sibling(env().notificationsQueueUrl, `${p}-retention-scheduler-dlq`),
  };

  it('notifications redrive to the notifications DLQ after 5 receives, and the queue is KMS-encrypted', async () => {
    const attrs = await attributes(env().notificationsQueueUrl);
    const redrive = JSON.parse(attrs['RedrivePolicy'] ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: number;
    };
    expect(redrive.deadLetterTargetArn).toMatch(new RegExp(`:${p}-dispute-notifications-dlq$`));
    expect(redrive.maxReceiveCount).toBe(5);
    expect(attrs['KmsMasterKeyId']).toBeTypeOf('string');
  });

  it('every DLQ exists and is KMS-encrypted', async () => {
    for (const [name, url] of Object.entries(dlqs)) {
      expect((await attributes(url))['KmsMasterKeyId'], `${name} encryption`).toBeTypeOf('string');
    }
  });

  it('the SES events queue is reachable by the e2e role and encrypted', async () => {
    expect((await attributes(env().sesEventsQueueUrl))['KmsMasterKeyId']).toBeTypeOf('string');
  });
});

describe('alarms', () => {
  const p = env().namePrefix;
  const expected = [
    'dlq-notifications',
    'dlq-evidence-intake',
    'dlq-retention-scheduler',
    'event-publish-failed',
    'retention-failed',
    'evidence-not-scanned',
    'evidence-result-conflict',
  ].map((key) => `${p}-${key}`);

  it('the DLQ, publish-failure and evidence alarms exist, notify the alarm topic, and no DLQ alarm is firing', async () => {
    const out = await cloudwatch().send(new DescribeAlarmsCommand({ AlarmNames: expected }));
    const alarms = [...(out.MetricAlarms ?? []), ...(out.CompositeAlarms ?? [])];
    expect(alarms.map((alarm) => alarm.AlarmName).sort()).toEqual([...expected].sort());
    for (const alarm of alarms) {
      expect(alarm.ActionsEnabled, alarm.AlarmName).toBe(true);
      expect(alarm.AlarmActions?.length ?? 0, `${alarm.AlarmName} actions`).toBeGreaterThan(0);
      if (alarm.AlarmName?.startsWith(`${p}-dlq-`))
        expect(alarm.StateValue, alarm.AlarmName).not.toBe('ALARM');
    }
  });
});
