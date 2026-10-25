import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Json, Reply } from './stack.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const MOTO = process.env['E2E_MOTO_URL'] ?? 'http://localhost:55000';
const SES_SINK = process.env['E2E_SES_SINK_URL'] ?? 'http://127.0.0.1:55901';
const ACCOUNT = '123456789012';

const COMPOSE = [
  'compose',
  '--env-file',
  'local/.env.example',
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.services.yml',
  '-f',
  'docker-compose.lambdas.yml',
];

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const until = async <T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 45_000,
  everyMs = 500,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
};

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const sha256Base64 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');

const awsAuth = (service: 's3' | 'sqs'): Record<string, string> => ({
  authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/eu-north-1/${service}/aws4_request, SignedHeaders=host, Signature=local`,
});

// moto accepts any credentials but treats an unsigned request as anonymous, which the bucket policy denies.
export const objectExists = async (bucket: string, key: string): Promise<boolean> => {
  const res = await fetch(`${MOTO}/${bucket}/${key}`, { method: 'HEAD', headers: awsAuth('s3') });
  if (res.status !== 200 && res.status !== 404) throw new Error(`HEAD ${bucket}/${key} returned ${res.status}`);
  return res.status === 200;
};

export const putQuarantineObject = async (key: string, body: Uint8Array): Promise<void> => {
  const res = await fetch(`${MOTO}/cd-evidence-quarantine/${key}`, {
    method: 'PUT',
    headers: awsAuth('s3'),
    body,
  });
  if (res.status !== 200) throw new Error(`PUT quarantine ${key} returned ${res.status}`);
};

const xmlText = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const sqs = async (queue: string, params: Record<string, string>): Promise<string> => {
  const res = await fetch(`${MOTO}/${ACCOUNT}/${queue}`, {
    method: 'POST',
    headers: { ...awsAuth('sqs'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Version: '2012-11-05', ...params }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`SQS ${params['Action']} on ${queue} returned ${res.status}: ${text.slice(0, 200)}`);
  return text;
};

export const sendNotification = async (body: string): Promise<void> => {
  await sqs('dispute-notifications', { Action: 'SendMessage', MessageBody: body });
};

type QueueMessage = { readonly body: string; readonly receiptHandle: string };

const parseMessages = (xml: string): readonly QueueMessage[] =>
  [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].flatMap((match) => {
    const body = /<Body>([\s\S]*?)<\/Body>/.exec(match[1] ?? '')?.[1];
    const receiptHandle = /<ReceiptHandle>([\s\S]*?)<\/ReceiptHandle>/.exec(match[1] ?? '')?.[1];
    return body === undefined || receiptHandle === undefined
      ? []
      : [{ body: xmlText(body), receiptHandle: xmlText(receiptHandle) }];
  });

// A DLQ keeps old messages, so one batch can miss ours: hide what was read, page on, then make the rest visible again.
const findInQueue = async (queue: string, marker: string): Promise<QueueMessage | undefined> => {
  const seen: QueueMessage[] = [];
  let match: QueueMessage | undefined;
  for (let page = 0; page < 100 && match === undefined; page += 1) {
    const batch = parseMessages(
      await sqs(queue, { Action: 'ReceiveMessage', MaxNumberOfMessages: '10', VisibilityTimeout: '120' }),
    );
    if (batch.length === 0) break;
    match = batch.find((message) => message.body.includes(marker));
    seen.push(...batch.filter((message) => message !== match));
  }
  await Promise.all(
    seen.map((message) =>
      sqs(queue, { Action: 'ChangeMessageVisibility', ReceiptHandle: message.receiptHandle, VisibilityTimeout: '0' }),
    ),
  );
  return match;
};

// Removes the matched message so reruns stay clean.
export const takeFromDlq = async (queue: string, marker: string, timeoutMs: number): Promise<string> => {
  const found = await until(`a message containing ${marker} in ${queue}`, () => findInQueue(queue, marker), timeoutMs, 1000);
  await sqs(queue, { Action: 'DeleteMessage', ReceiptHandle: found.receiptHandle });
  return found.body;
};

export const NOTIFICATIONS_DEAD_LETTERS = 'dispute-notifications-dlq';
export const INTAKE_DEAD_LETTERS = 'evidence-intake-dlq';

export type SentEmail = {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
};

export const sentEmails = async (): Promise<readonly SentEmail[]> => {
  const res = await fetch(`${SES_SINK}/sent`);
  return (await res.json()) as SentEmail[];
};

export const clearSentEmails = async (): Promise<void> => {
  const res = await fetch(`${SES_SINK}/sent`, { method: 'DELETE' });
  if (res.status !== 204) throw new Error(`DELETE /sent returned ${res.status}`);
};

const docker = (args: readonly string[], input?: string): string =>
  execFileSync('docker', [...COMPOSE, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

// Superuser on the compose Postgres, the same admin the host-side seed uses (DB_ADMIN_URL); psql runs inside the container.
export const adminRows = (sql: string, options: { readonly raw?: boolean } = {}): readonly Json[] => {
  const out = docker(
    ['exec', '-T', 'postgres', 'psql', '-U', process.env['POSTGRES_USER'] ?? 'postgres', '-d', 'disputes', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    options.raw === true ? sql : `select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`,
  );
  return JSON.parse(out.trim()) as Json[];
};

export const adminExec = (sql: string): void => {
  docker(
    ['exec', '-T', 'postgres', 'psql', '-U', process.env['POSTGRES_USER'] ?? 'postgres', '-d', 'disputes', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    sql,
  );
};

const NET_SCRIPT = `
(async () => {
  const [url, method, token, body] = process.argv.slice(1);
  const headers = {};
  if (token !== 'none') headers.authorization = 'Bearer ' + token;
  if (body !== 'none') headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, ...(body !== 'none' ? { body } : {}) });
  console.log(JSON.stringify({ status: res.status, body: await res.text() }));
})();
`;

// Service ports (8081) are never published, so these calls run from inside the compose network.
export const inNetwork = (
  service: 'users' | 'disputes',
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Reply => {
  const out = docker([
    'exec',
    '-T',
    service,
    'node',
    '-e',
    NET_SCRIPT,
    `http://${service}:8081${path}`,
    method,
    options.token ?? 'none',
    options.body === undefined ? 'none' : JSON.stringify(options.body),
  ]);
  const { status, body } = JSON.parse(out.trim()) as { status: number; body: string };
  let parsed: unknown;
  try {
    parsed = body === '' ? null : JSON.parse(body);
  } catch {
    parsed = body;
  }
  return { status, headers: new Headers(), body: parsed as Json };
};

export type DriverResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

// The same CLI as `pnpm --filter @cd/lambda-driver start invoke`, aimed at the published RIE ports.
export const driverInvoke = (fn: 'evidence-intake' | 'dispute-notifier' | 'retention-sweeper', event: unknown): DriverResult => {
  const rie = (port: string): string => `http://127.0.0.1:${port}/2015-03-31/functions/function/invocations`;
  try {
    const stdout = execFileSync(process.execPath, ['src/main.ts', 'invoke', fn, JSON.stringify(event)], {
      cwd: fileURLToPath(new URL('../../../local/lambda-driver', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AWS_ENDPOINT_URL: MOTO,
        AWS_REGION: 'eu-north-1',
        INTAKE_URL: rie(process.env['INTAKE_HOST_PORT'] ?? '58091'),
        NOTIFIER_URL: rie(process.env['NOTIFIER_HOST_PORT'] ?? '58092'),
        SWEEPER_URL: rie(process.env['SWEEPER_HOST_PORT'] ?? '58093'),
      },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
};
