import { fileURLToPath } from 'node:url';
import { ROLES, type Role } from '@cd/db/bootstrap';
import { createLogger } from '@cd/shared';
import { DEFAULT_SEED, generateSeedData } from './generate.ts';
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

const log = createLogger();

const run = async (): Promise<number> => {
  const now = seedNow();
  if (Number.isNaN(now.getTime())) {
    log.error('seed: SEED_NOW is not a valid ISO date');
    return 1;
  }
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

process.exitCode = await run().catch((e: unknown) => {
  log.error({ message: e instanceof Error ? e.message : String(e) }, 'seed crashed');
  return 1;
});
