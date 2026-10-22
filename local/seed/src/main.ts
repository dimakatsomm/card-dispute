import { fileURLToPath } from 'node:url';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ROLES, type Role } from '@cd/db/bootstrap';
import { createLogger } from '@cd/shared';
import { resolveAwsSeedConfig, runAwsSeed } from './aws-seed.ts';
import { DEFAULT_SEED, generateSeedData } from './generate.ts';
import { generatePassword } from './password.ts';
import { runSeed } from './seed.ts';

const env = (key: string, fallback: string): string => process.env[key] || fallback;

// Local-only dummies mirroring local/.env.example; the same variable names as @cd/db's bootstrap CLI.
const adminUrl = (): string =>
  env(
    'DB_ADMIN_URL',
    `postgres://${env('POSTGRES_USER', 'postgres')}:${encodeURIComponent(env('POSTGRES_PASSWORD', 'local-dev-postgres-password'))}` +
      `@${env('POSTGRES_HOST', 'localhost')}:${env('POSTGRES_HOST_PORT', '55432')}/${env('POSTGRES_DB', 'disputes')}`,
  );

const passwords = (): Record<Role, string> =>
  Object.fromEntries(
    ROLES.map((role) => [role, env(`DB_PASSWORD_${role.toUpperCase()}`, `local-dev-${role}-password`)]),
  ) as Record<Role, string>;

// SEED_NOW pins the clock for reproducible data; by default dates are relative to today so the 119/121-day cases hold.
const seedNow = (): Date => new Date(env('SEED_NOW', new Date().toISOString()));

const log = createLogger({ level: env('LOG_LEVEL', 'info') });

const runLocal = async (now: Date): Promise<number> => {
  const result = await runSeed({
    adminConnectionString: adminUrl(),
    passwords: passwords(),
    backendDir: fileURLToPath(new URL('../../../backend', import.meta.url)),
    data: generateSeedData({ seed: DEFAULT_SEED, now }),
  });
  if (!result.ok) {
    log.error({ error: result.error }, 'seed failed');
    return 1;
  }
  log.info({ now: now.toISOString(), inserted: result.value }, 'seed complete');
  return 0;
};

const runAws = async (now: Date): Promise<number> => {
  const config = resolveAwsSeedConfig(process.env);
  if (!config.ok) {
    log.error(config.error, 'seed: missing or invalid environment variables');
    return 1;
  }
  const { migratorUrls, ...cognito } = config.value;
  const result = await runAwsSeed({
    provision: {
      ...cognito,
      cognito: new CognitoIdentityProviderClient({}),
      secrets: new SecretsManagerClient({}),
      newPassword: () => generatePassword(),
    },
    urlFor: (svc) => migratorUrls[svc],
  })(generateSeedData({ seed: DEFAULT_SEED, now }));
  if (!result.ok) {
    log.error({ error: result.error }, 'seed failed');
    return 1;
  }
  log.info({ target: 'aws', now: now.toISOString(), changed: result.value }, 'seed complete');
  return 0;
};

const run = async (): Promise<number> => {
  const now = seedNow();
  if (Number.isNaN(now.getTime())) {
    log.error('seed: SEED_NOW is not a valid ISO date');
    return 1;
  }
  const target = env('SEED_TARGET', 'local');
  if (target === 'aws') return runAws(now);
  if (target === 'local') return runLocal(now);
  log.error({ allowed: ['local', 'aws'] }, 'seed: unknown SEED_TARGET');
  return 1;
};

process.exitCode = await run().catch((e: unknown) => {
  log.error({ message: e instanceof Error ? e.message : String(e) }, 'seed crashed');
  return 1;
});
