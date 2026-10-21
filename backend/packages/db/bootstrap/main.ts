import { createLogger } from '@cd/shared';
import { resolveAdminUrl } from './admin-url.ts';
import { bootstrap, ROLES, type Role } from './bootstrap.ts';

// Aurora needs sslmode=verify-full (added when assembling from DB_ADMIN_*); every run rotates each role password to the supplied value.
const passwordEnv = (role: Role): string => `DB_PASSWORD_${role.toUpperCase()}`;

const log = createLogger();

const run = async (): Promise<number> => {
  const admin = resolveAdminUrl(process.env);
  const missing = [
    ...(admin.ok ? [] : admin.error.missing),
    ...ROLES.map(passwordEnv).filter((k) => !process.env[k]),
  ];
  if (!admin.ok && admin.error.invalid.length > 0) {
    log.error({ invalid: admin.error.invalid }, 'bootstrap: insecure or malformed environment variables');
    return 1;
  }
  if (!admin.ok || missing.length > 0) {
    log.error({ missing }, 'bootstrap: missing environment variables');
    return 1;
  }
  const passwords = Object.fromEntries(
    ROLES.map((role) => [role, process.env[passwordEnv(role)] ?? '']),
  ) as Record<Role, string>;
  const result = await bootstrap({ adminConnectionString: admin.value, passwords });
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
