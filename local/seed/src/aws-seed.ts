import { SERVICES } from '@cd/db/bootstrap';
import { err, ok, type Result } from '@cd/shared/fp';
import { provisionSeedUsers, type ProvisionDeps, type ProvisionError, type SeedUser } from './cognito.ts';
import type { SeedData } from './generate.ts';
import { insertAll, type InsertedCounts, type SeedError, type Service, type UrlFor } from './seed.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export type AwsSeedConfig = {
  readonly userPoolId: string;
  readonly secretPrefix: string;
  readonly kmsKeyId: string;
  readonly rotatePasswords: boolean;
  readonly migratorUrls: Readonly<Record<Service, string>>;
};

export type ConfigError = { readonly missing: ReadonlyArray<string>; readonly invalid: ReadonlyArray<string> };

export type AwsSeedError =
  | ProvisionError
  | SeedError
  | { readonly kind: 'unprovisioned'; readonly username: string };

const migratorEnv = (svc: Service): string => `MIGRATOR_DATABASE_URL_${svc.toUpperCase()}`;

const REQUIRED = [
  'COGNITO_USER_POOL_ID',
  'SEED_USER_SECRET_PREFIX',
  'SEED_USER_SECRET_KMS_KEY_ID',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  ...SERVICES.map(migratorEnv),
] as const;

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

// Allowlist: exactly the task's cluster, that schema's migrator, and sslmode=verify-full as the only parameter,
// because pg-connection-string honours extras (sslrootcert, uselibpqcompat, ...) that can weaken verification.
const isExpectedMigratorUrl = (raw: string, svc: Service, env: Env): boolean => {
  const url = parseUrl(raw);
  return (
    url !== undefined &&
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.hash === '' &&
    [...url.searchParams].length === 1 &&
    url.hostname === env.DB_HOST?.toLowerCase() &&
    url.port === env.DB_PORT &&
    decodeURIComponent(url.pathname.slice(1)) === env.DB_NAME &&
    decodeURIComponent(url.username) === `${svc}_migrator` &&
    url.searchParams.get('sslmode') === 'verify-full'
  );
};

export const resolveAwsSeedConfig = (env: Env): Result<AwsSeedConfig, ConfigError> => {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) return err({ missing, invalid: [] });
  const invalid = [
    ...(env.SEED_USER_SECRET_PREFIX?.endsWith('/') ? [] : ['SEED_USER_SECRET_PREFIX']),
    ...(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(env.SEED_USER_SECRET_KMS_KEY_ID ?? '')
      ? []
      : ['SEED_USER_SECRET_KMS_KEY_ID']),
    ...SERVICES.filter((svc) => !isExpectedMigratorUrl(env[migratorEnv(svc)] ?? '', svc, env)).map(migratorEnv),
  ];
  if (invalid.length > 0) return err({ missing: [], invalid });
  return ok({
    userPoolId: env.COGNITO_USER_POOL_ID ?? '',
    secretPrefix: env.SEED_USER_SECRET_PREFIX ?? '',
    kmsKeyId: env.SEED_USER_SECRET_KMS_KEY_ID ?? '',
    rotatePasswords: env.SEED_ROTATE_USER_PASSWORDS === 'true',
    migratorUrls: Object.fromEntries(SERVICES.map((svc) => [svc, env[migratorEnv(svc)] ?? ''])) as Record<Service, string>,
  });
};

export const seedUsers = (data: SeedData): ReadonlyArray<SeedUser> => {
  const emails = new Map(data.appUsers.map((u) => [u.user_id, u.email]));
  return data.authIdentities.map((i) => ({
    username: i.username,
    email: emails.get(i.user_id) ?? `${i.username}@example.com`,
    disabled: i.status === 'DISABLED',
  }));
};

export const withCognitoSubs = (
  data: SeedData,
  subs: ReadonlyMap<string, string>,
): Result<SeedData, { readonly kind: 'unprovisioned'; readonly username: string }> => {
  const missing = data.authIdentities.find((i) => !subs.has(i.username));
  if (missing !== undefined) return err({ kind: 'unprovisioned', username: missing.username });
  return ok({
    ...data,
    authIdentities: data.authIdentities.map((i) => ({ ...i, cognito_sub: subs.get(i.username) ?? i.cognito_sub })),
  });
};

export type AwsSeedDeps = { readonly provision: ProvisionDeps; readonly urlFor: UrlFor };

// Bootstrap and migrations are their own tasks in AWS; this only provisions identities and inserts rows.
export const runAwsSeed =
  (deps: AwsSeedDeps) =>
  async (data: SeedData): Promise<Result<InsertedCounts, AwsSeedError>> => {
    const provisioned = await provisionSeedUsers(deps.provision)(seedUsers(data));
    if (!provisioned.ok) return provisioned;
    const mapped = withCognitoSubs(data, provisioned.value.subs);
    if (!mapped.ok) return mapped;
    const inserted = await insertAll(mapped.value, deps.urlFor);
    return inserted.ok ? ok({ ...provisioned.value.counts, ...inserted.value }) : inserted;
  };
