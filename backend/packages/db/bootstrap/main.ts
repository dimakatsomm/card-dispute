import { createLogger } from '@cd/shared';
import { bootstrap, ROLES, type Role } from './bootstrap.ts';

// DB_ADMIN_URL must use sslmode=require on Aurora; every run rotates each role's password to the supplied value.
const passwordEnv = (role: Role): string => `DB_PASSWORD_${role.toUpperCase()}`;

const log = createLogger();

const run = async (): Promise<number> => {
  const adminConnectionString = process.env.DB_ADMIN_URL;
  const missing = [
    ...(adminConnectionString ? [] : ['DB_ADMIN_URL']),
    ...ROLES.map(passwordEnv).filter((k) => !process.env[k]),
  ];
  if (!adminConnectionString || missing.length > 0) {
    log.error({ missing }, 'bootstrap: missing environment variables');
    return 1;
  }
  const passwords = Object.fromEntries(
    ROLES.map((role) => [role, process.env[passwordEnv(role)] ?? '']),
  ) as Record<Role, string>;
  const result = await bootstrap({ adminConnectionString, passwords });
  if (!result.ok) {
    log.error({ error: result.error }, 'bootstrap failed');
    return 1;
  }
  log.info({ roles: result.value }, 'bootstrap complete');
  return 0;
};

process.exitCode = await run().catch((e: unknown) => {
  log.error({ message: e instanceof Error ? e.message : String(e) }, 'bootstrap crashed');
  return 1;
});
