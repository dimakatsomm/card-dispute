import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createHttpClient, createServiceTokenProvider, type Fetch } from '@cd/auth-client/service-client';
import { err, ok, type Result } from '@cd/shared/fp';
import { createLogger, createSecretResolver, loadConfig, type Env } from '@cd/shared/lambda';
import { createDisputesClient } from './adapters/disputes-client.ts';
import { createSesSender } from './adapters/ses-sender.ts';
import { createUsersClient } from './adapters/users-client.ts';
import { configSchema, logLevelSchema, type Config } from './config.ts';
import { createHandler, createLazyHandler, type SqsHandler } from './handler.ts';
import { notifyCustomer } from './use-cases/notify-customer.ts';
import type { Log } from './use-cases/ports.ts';

export const UPSTREAM_DEADLINE_MS = 2000;

export type Runtime = {
  readonly env: Env;
  readonly fetch: Fetch;
  readonly nowMs: () => number;
  readonly log: Log;
  readonly deadlineMs?: number;
};

const readConfig = (env: Env): Result<Config, string> => {
  try {
    return ok(loadConfig(configSchema, env));
  } catch (error) {
    return err(error instanceof Error ? error.message : 'invalid configuration');
  }
};

const clientSecret = async (config: Config): Promise<Result<string, string>> => {
  if (config.SERVICE_CLIENT_SECRET !== undefined) return ok(config.SERVICE_CLIENT_SECRET);
  const resolve = createSecretResolver(new SecretsManagerClient({ region: config.AWS_REGION }));
  const secret = await resolve(config.SERVICE_CLIENT_SECRET_ARN ?? '');
  return secret.ok ? secret : err(`service client secret ${secret.error.kind}`);
};

export const compose = async (rt: Runtime): Promise<Result<SqsHandler, string>> => {
  const config = readConfig(rt.env);
  if (!config.ok) return config;
  const secret = await clientSecret(config.value);
  if (!secret.ok) return secret;
  const { TOKEN_URL, SERVICE_CLIENT_ID, AWS_REGION, SES_ENDPOINT, SES_SENDER } = config.value;

  // One token per callee, so a token leaked by one service cannot be replayed against the other (ADR-054).
  const tokens = (scope: string) =>
    createServiceTokenProvider({
      tokenUrl: TOKEN_URL,
      clientId: SERVICE_CLIENT_ID,
      clientSecret: secret.value,
      scopes: [scope],
      fetch: rt.fetch,
      now: rt.nowMs,
    });
  const upstream = {
    http: createHttpClient({ fetch: rt.fetch }),
    deadlineMs: rt.deadlineMs ?? UPSTREAM_DEADLINE_MS,
    log: rt.log,
  };
  const users = createUsersClient({
    ...upstream,
    upstream: 'users',
    baseUrl: config.value.USERS_SERVICE_URL,
    tokens: tokens('users/contact.read'),
  });
  const disputes = createDisputesClient({
    ...upstream,
    upstream: 'disputes',
    baseUrl: config.value.DISPUTES_SERVICE_URL,
    tokens: tokens('disputes/read'),
  });
  const ses = new SESv2Client({ region: AWS_REGION, ...(SES_ENDPOINT ? { endpoint: SES_ENDPOINT } : {}) });

  const notify = notifyCustomer({
    lookupDisputes: disputes.lookupDisputes,
    fetchContact: users.fetchContact,
    sendEmail: createSesSender({ client: ses, sender: SES_SENDER }),
  });
  return ok(createHandler({ notify, log: rt.log }));
};

export const createLambdaHandler = (rt: Runtime): SqsHandler =>
  createLazyHandler({ init: () => compose(rt), log: rt.log });

export const handler = createLambdaHandler({
  env: process.env,
  fetch: globalThis.fetch,
  nowMs: Date.now,
  log: createLogger({ level: logLevelSchema.parse(process.env['LOG_LEVEL']) }),
});
