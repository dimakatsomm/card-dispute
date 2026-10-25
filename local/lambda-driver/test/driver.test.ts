import {
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it } from 'vitest';
import { EICAR } from '../src/eicar.ts';
import { makeInvoke } from '../src/rie.ts';
import { SCAN_TAG, scanOnce, type ScanStubDeps } from '../src/scan-stub.ts';
import { buildSesSink } from '../src/ses-sink.ts';
import { pollOnce } from '../src/sqs-poller.ts';
import { makeBucket, makeQueue, REGION, s3, sqs, startFakeRie, type FakeRie } from './support.ts';

const cleanups: (() => Promise<unknown>)[] = [];
const rigs: FakeRie[] = [];
const cleanup = (fn: () => Promise<unknown>) => cleanups.push(fn);

const rie = async (...args: Parameters<typeof startFakeRie>) => {
  const fake = await startFakeRie(...args);
  rigs.push(fake);
  return fake;
};

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((fake) => fake.close()));
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const queueCounts = async (QueueUrl: string) => {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
  );
  return {
    visible: Number(Attributes['ApproximateNumberOfMessages']),
    inFlight: Number(Attributes['ApproximateNumberOfMessagesNotVisible']),
  };
};

describe('sqs poller', () => {
  const pollerDeps = (queueUrl: string, notifierUrl: string) => ({
    sqs,
    invoke: makeInvoke(5000),
    queueUrl,
    queueArn: 'arn:aws:sqs:eu-north-1:000000000000:test',
    region: REGION,
    notifierUrl,
    waitSeconds: 0,
  });

  const seed = async (queueUrl: string, bodies: string[]) => {
    for (const MessageBody of bodies) await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody }));
  };

  it('deletes only the records not in batchItemFailures', async () => {
    const queue = await makeQueue(cleanup, { VisibilityTimeout: '30' });
    await seed(queue.url, ['good-1', 'bad', 'good-2']);
    const notifier = await rie((request) => {
      const records = (request as { Records: { messageId: string; body: string }[] }).Records;
      const bad = records.find((r) => r.body === 'bad');
      return { body: JSON.stringify({ batchItemFailures: [{ itemIdentifier: bad?.messageId }] }) };
    });

    const deleted = await pollOnce(pollerDeps(queue.url, notifier.url));

    expect(deleted).toBe(2);
    const event = notifier.requests[0] as { Records: { body: string; eventSource: string }[] };
    expect(event.Records.map((r) => r.body).sort()).toEqual(['bad', 'good-1', 'good-2']);
    expect(event.Records[0]?.eventSource).toBe('aws:sqs');
    expect(await queueCounts(queue.url)).toEqual({ visible: 0, inFlight: 1 });
  });

  it('deletes nothing when the function errors', async () => {
    const queue = await makeQueue(cleanup, { VisibilityTimeout: '30' });
    await seed(queue.url, ['a', 'b']);
    const notifier = await rie(() => ({
      body: JSON.stringify({ errorType: 'Error', errorMessage: 'boom', trace: [] }),
    }));

    expect(await pollOnce(pollerDeps(queue.url, notifier.url))).toBe(0);
    expect(await queueCounts(queue.url)).toEqual({ visible: 0, inFlight: 2 });
  });
});

describe('scan stub', () => {
  const stubDeps = async (intakeUrl: string, retryDelayMs = 0) => {
    const bucket = await makeBucket(cleanup);
    const dlq = await makeQueue(cleanup);
    const deps: ScanStubDeps = {
      s3,
      sqs,
      invoke: makeInvoke(5000),
      now: () => new Date('2026-10-20T10:00:00Z'),
      bucket,
      region: REGION,
      intakeUrl,
      dlqName: dlq.name,
      retryDelayMs,
    };
    return { deps, dlq };
  };

  const put = (Bucket: string, Key: string, body: string) =>
    s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: 'application/pdf' }));

  const tagOf = async (Bucket: string, Key: string) => {
    const { TagSet = [] } = await s3.send(new GetObjectTaggingCommand({ Bucket, Key }));
    return TagSet.find((t) => t.Key === SCAN_TAG)?.Value;
  };

  it('tags EICAR THREATS_FOUND, clean files NO_THREATS_FOUND, posts events, and skips scanned objects', async () => {
    const intake = await rie(() => ({ body: 'null' }));
    const { deps } = await stubDeps(intake.url);
    await put(deps.bucket, 'intake/t1/bad', `%PDF-1.4 ${EICAR}`);
    await put(deps.bucket, 'intake/t1/good', '%PDF-1.4 clean');

    expect(await scanOnce(deps)).toBe(2);

    expect(await tagOf(deps.bucket, 'intake/t1/bad')).toBe('THREATS_FOUND');
    expect(await tagOf(deps.bucket, 'intake/t1/good')).toBe('NO_THREATS_FOUND');
    const events = intake.requests as {
      'detail-type': string;
      detail: {
        s3ObjectDetails: { bucketName: string; objectKey: string };
        scanResultDetails: { scanResultStatus: string };
      };
    }[];
    const byKey = Object.fromEntries(events.map((e) => [e.detail.s3ObjectDetails.objectKey, e]));
    expect(byKey['intake/t1/bad']?.detail.scanResultDetails.scanResultStatus).toBe('THREATS_FOUND');
    expect(byKey['intake/t1/good']?.detail.scanResultDetails.scanResultStatus).toBe('NO_THREATS_FOUND');
    expect(byKey['intake/t1/good']?.['detail-type']).toBe('GuardDuty Malware Protection Object Scan Result');
    expect(byKey['intake/t1/good']?.detail.s3ObjectDetails.bucketName).toBe(deps.bucket);

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: deps.bucket, Key: 'intake/t1/good', ChecksumMode: 'ENABLED' }),
    );
    expect(head.ChecksumSHA256).toBeTruthy();
    expect(head.ContentType).toBe('application/pdf');

    expect(await scanOnce(deps)).toBe(0);
    expect(intake.requests).toHaveLength(2);
  });

  it('retries a failing intake twice, then sends the original event to the DLQ', async () => {
    const failures = [
      JSON.stringify({ errorType: 'Error', errorMessage: 'boom', trace: [] }),
      'Task timed out after 2.00 seconds',
      JSON.stringify({ errorType: 'Runtime.ExitError', errorMessage: 'exit' }),
    ];
    const intake = await rie((_request, call) => ({ body: failures[call - 1] ?? 'null' }));
    const { deps, dlq } = await stubDeps(intake.url);
    await put(deps.bucket, 'intake/t2/file', '%PDF-1.4 x');

    await scanOnce(deps);

    expect(intake.requests).toHaveLength(3);
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.url }));
    expect(Messages).toHaveLength(1);
    expect(JSON.parse(Messages[0]?.Body ?? '')).toEqual(intake.requests[0]);
  });

  it('does not use the DLQ when a retry succeeds', async () => {
    const intake = await rie((_request, call) => ({
      body: call === 1 ? 'Task timed out after 2.00 seconds' : 'null',
    }));
    const { deps, dlq } = await stubDeps(intake.url);
    await put(deps.bucket, 'intake/t3/file', '%PDF-1.4 x');

    await scanOnce(deps);

    expect(intake.requests).toHaveLength(2);
    expect(await queueCounts(dlq.url)).toEqual({ visible: 0, inFlight: 0 });
  });
});

describe('ses sink', () => {
  const send = (app: ReturnType<typeof buildSesSink>, to: string) =>
    app.inject({
      method: 'POST',
      url: '/v2/email/outbound-emails',
      payload: {
        FromEmailAddress: 'noreply@example.test',
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: 'Hello' }, Body: { Text: { Data: 'Body' } } } },
      },
    });

  it('stores accepted mail, rejects unverified recipients in sandbox mode, and clears on DELETE', async () => {
    const app = buildSesSink(['ok@example.test']);

    const accepted = await send(app, 'OK@example.test');
    expect(accepted.statusCode).toBe(200);

    const rejected = await send(app, 'stranger@example.test');
    expect(rejected.statusCode).toBe(400);
    expect(rejected.headers['x-amzn-errortype']).toBe('MessageRejected');

    const sent = (await app.inject({ method: 'GET', url: '/sent' })).json<{ to: string[]; subject: string }[]>();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['OK@example.test'], subject: 'Hello' });

    expect((await app.inject({ method: 'DELETE', url: '/sent' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/sent' })).json()).toEqual([]);
  });

  it('accepts everyone when no verified list is set', async () => {
    expect((await send(buildSesSink(undefined), 'anyone@example.test')).statusCode).toBe(200);
  });
});
