import { randomUUID } from 'node:crypto';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger } from '@cd/shared';
import { userId } from './generate.ts';
import { runProbe, sleep } from './probe-cli.ts';
import { serviceTokenVia, userTokenVia } from './probe-tokens.ts';

const TIMEOUT_MS = 5_000;

const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });
const value = (key: string): string => process.env[key] ?? '';

const run = runProbe({
  env: process.env,
  log,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  userId: userId('A'),
  newId: randomUUID,
  sleep,
  probe: () => ({
    fetch,
    timeoutMs: TIMEOUT_MS,
    userToken: userTokenVia({
      cognito: new CognitoIdentityProviderClient({}),
      secrets: new SecretsManagerClient({}),
      userPoolId: value('COGNITO_USER_POOL_ID'),
      clientId: value('E2E_CLIENT_ID'),
      secretId: value('PROBE_USER_SECRET_ID'),
    }),
    serviceToken: serviceTokenVia({
      fetch,
      tokenUrl: value('TOKEN_URL'),
      clientId: value('SERVICE_CLIENT_ID'),
      clientSecret: value('SERVICE_CLIENT_SECRET'),
      timeoutMs: TIMEOUT_MS,
    }),
  }),
});

process.exitCode = await run(process.argv.slice(2)).catch((e: unknown) => {
  log.error({ name: e instanceof Error ? e.name : 'UnknownError' }, 'probe crashed');
  return 1;
});
