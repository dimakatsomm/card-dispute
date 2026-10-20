import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { makeS3, makeSqs } from './aws.ts';
import { loadConfig, type Config } from './config.ts';
import { makeInvoke } from './rie.ts';
import { scanOnce } from './scan-stub.ts';
import { buildSesSink } from './ses-sink.ts';
import { pollOnce } from './sqs-poller.ts';

const functionUrls = (config: Config): Readonly<Record<string, string>> => ({
  'evidence-intake': config.INTAKE_URL,
  'dispute-notifier': config.NOTIFIER_URL,
  'retention-sweeper': config.SWEEPER_URL,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const forever = async (step: () => Promise<unknown>, pauseMs: number): Promise<never> => {
  for (;;) {
    try {
      await step();
    } catch (error) {
      console.error('step failed', error);
      await sleep(Math.max(pauseMs, 1000));
    }
    await sleep(pauseMs);
  }
};

const runScanStub = (config: Config) => {
  const deps = {
    s3: makeS3(config),
    sqs: makeSqs(config),
    invoke: makeInvoke(config.INVOKE_TIMEOUT_MS),
    now: () => new Date(),
    bucket: config.QUARANTINE_BUCKET,
    region: config.AWS_REGION,
    intakeUrl: config.INTAKE_URL,
    dlqName: config.INTAKE_DLQ_NAME,
    retryDelayMs: config.INTAKE_RETRY_DELAY_MS,
  };
  return forever(() => scanOnce(deps), config.SCAN_INTERVAL_MS);
};

const runSqsPoller = async (config: Config) => {
  const sqs = makeSqs(config);
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.NOTIFICATIONS_QUEUE_NAME }));
  const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
  const deps = {
    sqs,
    invoke: makeInvoke(config.INVOKE_TIMEOUT_MS),
    queueUrl: QueueUrl ?? '',
    queueArn: attributes.Attributes?.['QueueArn'] ?? '',
    region: config.AWS_REGION,
    notifierUrl: config.NOTIFIER_URL,
    waitSeconds: 10,
  };
  return forever(() => pollOnce(deps), 0);
};

const runSesSink = async (config: Config) => {
  await buildSesSink(config.SES_VERIFIED).listen({ port: config.SES_PORT, host: '0.0.0.0' });
  console.log(`ses-sink listening on :${config.SES_PORT}`);
};

const runInvoke = async (config: Config, name: string | undefined, json: string | undefined) => {
  const urls = functionUrls(config);
  const url = name ? urls[name] : undefined;
  if (!url) {
    console.error(`usage: invoke <${Object.keys(urls).join('|')}> [json]`);
    process.exitCode = 2;
    return;
  }
  const result = await makeInvoke(config.INVOKE_TIMEOUT_MS)(url, json ? JSON.parse(json) : {});
  if (result.ok) console.log(JSON.stringify(result.payload));
  else {
    console.error(result.reason);
    process.exitCode = 1;
  }
};

const [mode, ...args] = process.argv.slice(2);
const config = loadConfig(process.env);

switch (mode) {
  case 'scan-stub':
    await runScanStub(config);
    break;
  case 'sqs-poller':
    await runSqsPoller(config);
    break;
  case 'ses-sink':
    await runSesSink(config);
    break;
  case 'invoke':
    await runInvoke(config, args[0], args[1]);
    break;
  default:
    console.error('usage: main.ts <scan-stub|sqs-poller|ses-sink|invoke>');
    process.exitCode = 2;
}
