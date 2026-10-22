import { randomUUID } from 'node:crypto';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger } from '@cd/shared';
import { userId } from './generate.ts';
import { allPassed, parseHttpUrl, probeDenials, probeUnreachable, type CheckResult, type ProbeDeps } from './probe.ts';
import { serviceTokenVia, userTokenVia } from './probe-tokens.ts';

const USAGE = `usage: probe [--expect-unreachable]
  default               service port answers; user token 403, no token 401, svc-notifier PUT evidence 403
  --expect-unreachable  every connection to SERVICE_PORT_BASE_URL fails or times out
env: SERVICE_PORT_BASE_URL; default mode also COGNITO_USER_POOL_ID, PROBE_USER_SECRET_ID, E2E_CLIENT_ID,
     SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET, TOKEN_URL
`;

const TIMEOUT_MS = 5_000;
const DENIAL_ENV = [
  'SERVICE_PORT_BASE_URL',
  'COGNITO_USER_POOL_ID',
  'PROBE_USER_SECRET_ID',
  'E2E_CLIENT_ID',
  'SERVICE_CLIENT_ID',
  'SERVICE_CLIENT_SECRET',
  'TOKEN_URL',
] as const;

const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });
const value = (key: string): string => process.env[key] ?? '';

const report = (results: ReadonlyArray<CheckResult>): number => {
  for (const r of results) {
    log.info({ check: r.check, expected: r.expected, observed: r.observed, code: r.code, pass: r.pass }, 'probe check');
  }
  const passed = allPassed(results);
  log.info({ passed, checks: results.length }, passed ? 'probe passed' : 'probe failed');
  return passed ? 0 : 1;
};

const run = async (args: ReadonlyArray<string>): Promise<number> => {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== '--expect-unreachable');
  if (unknown.length > 0) {
    process.stderr.write(USAGE);
    return 64;
  }
  const expectUnreachable = args.includes('--expect-unreachable');
  const required = expectUnreachable ? ['SERVICE_PORT_BASE_URL'] : DENIAL_ENV;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    log.error({ missing }, 'probe: missing environment variables');
    return 1;
  }
  const invalid = [
    ...(parseHttpUrl(value('SERVICE_PORT_BASE_URL')) === null ? ['SERVICE_PORT_BASE_URL'] : []),
    ...(!expectUnreachable && parseHttpUrl(value('TOKEN_URL'), ['https:']) === null ? ['TOKEN_URL'] : []),
  ];
  if (invalid.length > 0) {
    log.error({ invalid }, 'probe: invalid environment variables (SERVICE_PORT_BASE_URL http(s), TOKEN_URL https)');
    return 1;
  }
  const deps: ProbeDeps = {
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
  };
  if (expectUnreachable) return report(await probeUnreachable(deps)([value('SERVICE_PORT_BASE_URL')]));
  const denials = await probeDenials(deps)({
    serviceBaseUrl: value('SERVICE_PORT_BASE_URL'),
    userId: userId('A'),
    unknownId: randomUUID,
  });
  if (!denials.ok) {
    log.error({ error: denials.error }, 'probe: could not obtain a token');
    return 1;
  }
  return report(denials.value);
};

process.exitCode = await run(process.argv.slice(2)).catch((e: unknown) => {
  log.error({ name: e instanceof Error ? e.name : 'UnknownError' }, 'probe crashed');
  return 1;
});
