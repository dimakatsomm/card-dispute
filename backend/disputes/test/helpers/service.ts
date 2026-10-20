import { randomUUID } from 'node:crypto';
import type { Fetch } from '@cd/auth-client';
import { createLogger, type Servers } from '@cd/shared';
import type pg from 'pg';
import type { QueueMessage, SendMessage } from '../../src/adapters/event-publisher.ts';
import { createUploadSigner, type PresignUploads } from '../../src/adapters/upload-signer.ts';
import { loadDisputesConfig } from '../../src/config.ts';
import { composeServers, type Infra } from '../../src/main.ts';
import { URLS, type FakeUpstreams } from './fakes.ts';

export const QUARANTINE_BUCKET = 'cd-evidence-quarantine';
export const QUEUE_URL = 'http://sqs.test/000000000000/dispute-notifications';

export type TestService = {
  readonly servers: Servers;
  readonly messages: ReadonlyArray<QueueMessage>;
  readonly logLines: () => ReadonlyArray<Record<string, unknown>>;
};

export type TestServiceOptions = {
  readonly pool: Infra['pool'];
  readonly upstreams: FakeUpstreams;
  readonly s3Endpoint: string;
  readonly send?: SendMessage;
  readonly now?: () => Date;
  // Lets a test fault one upstream; anything it returns undefined for goes to the fakes.
  readonly fault?: (url: URL, body: string, init?: RequestInit) => Promise<Response> | undefined;
  readonly presign?: PresignUploads;
};

export const startTestService = async (options: TestServiceOptions): Promise<TestService> => {
  const messages: QueueMessage[] = [];
  const lines: string[] = [];
  const now = options.now ?? (() => new Date());
  const config = loadDisputesConfig({
    DATABASE_URL: 'postgres://unused-by-tests',
    AUTH_URL: URLS.auth,
    TRANSACTIONS_SERVICE_URL: URLS.transactions,
    USERS_SERVICE_URL: URLS.users,
    TOKEN_URL: URLS.token,
    SERVICE_CLIENT_ID: 'svc-disputes',
    SERVICE_CLIENT_SECRET: 'fake-client-secret',
    S3_ENDPOINT: options.s3Endpoint,
    S3_FORCE_PATH_STYLE: 'true',
    QUARANTINE_BUCKET,
    NOTIFICATIONS_QUEUE_URL: QUEUE_URL,
  });
  const { fault } = options;
  const fetch: Fetch =
    fault === undefined
      ? options.upstreams.fetch
      : (input, init) =>
          fault(new URL(String(input)), typeof init?.body === 'string' ? init.body : '', init) ??
          options.upstreams.fetch(input, init);
  const servers = composeServers({
    config,
    pool: options.pool,
    fetch,
    sendMessage:
      options.send ??
      (async (m) => {
        messages.push(m);
      }),
    presignUploads:
      options.presign ??
      createUploadSigner({
        region: config.AWS_REGION,
        bucket: QUARANTINE_BUCKET,
        endpoint: options.s3Endpoint,
        forcePathStyle: true,
        now,
      }),
    logger: createLogger({ level: 'info', destination: { write: (s: string) => void lines.push(s) } }),
    now,
    newId: randomUUID,
    sleep: async () => undefined,
  });
  await Promise.all([servers.public.ready(), servers.service.ready()]);
  return {
    servers,
    messages,
    logLines: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
};
// Fails the statement that follows the dispute insert, to prove the create transaction is all-or-nothing.
export const poolFailingOn = (pool: pg.Pool, sqlFragment: string): Infra['pool'] =>
  ({
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get: (target, prop, receiver) => {
          if (prop === 'query') {
            return (sql: unknown, ...rest: unknown[]) =>
              typeof sql === 'string' && sql.includes(sqlFragment)
                ? Promise.reject(new Error('forced failure'))
                : (target.query as (...a: unknown[]) => unknown).call(target, sql, ...rest);
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  }) as unknown as Infra['pool'];
