import { SERVICES } from '@cd/db/bootstrap';
import { err, ok, type Result } from '@cd/shared/fp';
import { provisionAgent, type AgentError, type AgentStatus, type SeedAgent } from './agent.ts';
import { provisionSeedUsers, type ProvisionDeps, type ProvisionError, type SeedUser } from './cognito.ts';
import { userId, type SeedData } from './generate.ts';
import { insertAll, type InsertedCounts, type SeedError, type Service, type UrlFor } from './seed.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export type AwsSeedConfig = {
  readonly userPoolId: string;
  readonly secretPrefix: string;
  readonly kmsKeyId: string;
  readonly rotatePasswords: boolean;
  readonly emailA: string | null;
  readonly agent: SeedAgent | null;
  readonly migratorUrls: Readonly<Record<Service, string>>;
};

export type ConfigError = { readonly missing: ReadonlyArray<string>; readonly invalid: ReadonlyArray<string> };

export type AwsSeedError =
  | AgentError
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

const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
// Plausible, not full RFC 5322: a dot-atom local part, a host of at least two LDH labels, SMTP length limits.
const EMAIL = new RegExp(`^(?=[^@]{1,64}@)${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})+$`);

export const isPlausibleEmail = (raw: string): boolean => raw.length <= 254 && EMAIL.test(raw);

const AGENT_ENV = ['SEED_AGENT_USERNAME', 'SEED_AGENT_EMAIL', 'SEED_AGENT_DISPLAY_NAME'] as const;
const AGENT_REQUIRED = [...AGENT_ENV, 'SEED_AGENT_SECRET_PREFIX'] as const;

const isSeparateAgentPrefix = (agent: string, user: string): boolean =>
  agent.endsWith('/') && !agent.startsWith(user) && !user.startsWith(agent);

// Lower case only, like auth_identity.username, because the pool compares usernames case-insensitively.
const isAgentUsername = (raw: string): boolean => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(raw);

// Mirrors the agent_identity check (1-80 code points, not blank); control characters would corrupt timelines.
const isDisplayName = (raw: string): boolean => [...raw].length <= 80 && raw.trim() !== '' && !/\p{Cc}/u.test(raw);

const agentInvalid = (env: Env): ReadonlyArray<string> => {
  if (!AGENT_ENV.some((k) => env[k])) {
    return ['SEED_AGENT_REQUIRE_TOTP', 'SEED_AGENT_SECRET_PREFIX'].filter((k) => env[k]);
  }
  return [
    ...(isAgentUsername(env.SEED_AGENT_USERNAME ?? '') ? [] : ['SEED_AGENT_USERNAME']),
    ...(isPlausibleEmail(env.SEED_AGENT_EMAIL ?? '') ? [] : ['SEED_AGENT_EMAIL']),
    ...(isDisplayName(env.SEED_AGENT_DISPLAY_NAME ?? '') ? [] : ['SEED_AGENT_DISPLAY_NAME']),
    ...(['', 'true', 'false'].includes(env.SEED_AGENT_REQUIRE_TOTP ?? '') ? [] : ['SEED_AGENT_REQUIRE_TOTP']),
    ...(isSeparateAgentPrefix(env.SEED_AGENT_SECRET_PREFIX ?? '', env.SEED_USER_SECRET_PREFIX ?? '')
      ? []
      : ['SEED_AGENT_SECRET_PREFIX']),
  ];
};

const agentOf = (env: Env): SeedAgent | null =>
  env.SEED_AGENT_USERNAME
    ? {
        username: env.SEED_AGENT_USERNAME,
        email: env.SEED_AGENT_EMAIL ?? '',
        displayName: env.SEED_AGENT_DISPLAY_NAME ?? '',
        requireTotp: env.SEED_AGENT_REQUIRE_TOTP === 'true',
        secretPrefix: env.SEED_AGENT_SECRET_PREFIX ?? '',
      }
    : null;

export const resolveAwsSeedConfig = (env: Env): Result<AwsSeedConfig, ConfigError> => {
  const agentMissing = AGENT_ENV.some((k) => env[k]) ? AGENT_REQUIRED.filter((k) => !env[k]) : [];
  const missing = [...REQUIRED.filter((k) => !env[k]), ...agentMissing];
  if (missing.length > 0) return err({ missing, invalid: [] });
  const invalid = [
    ...(env.SEED_USER_SECRET_PREFIX?.endsWith('/') ? [] : ['SEED_USER_SECRET_PREFIX']),
    ...(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(env.SEED_USER_SECRET_KMS_KEY_ID ?? '')
      ? []
      : ['SEED_USER_SECRET_KMS_KEY_ID']),
    ...SERVICES.filter((svc) => !isExpectedMigratorUrl(env[migratorEnv(svc)] ?? '', svc, env)).map(migratorEnv),
    ...(!env.SEED_A_EMAIL || isPlausibleEmail(env.SEED_A_EMAIL) ? [] : ['SEED_A_EMAIL']),
    ...agentInvalid(env),
  ];
  if (invalid.length > 0) return err({ missing: [], invalid });
  return ok({
    userPoolId: env.COGNITO_USER_POOL_ID ?? '',
    secretPrefix: env.SEED_USER_SECRET_PREFIX ?? '',
    kmsKeyId: env.SEED_USER_SECRET_KMS_KEY_ID ?? '',
    rotatePasswords: env.SEED_ROTATE_USER_PASSWORDS === 'true',
    emailA: env.SEED_A_EMAIL || null,
    agent: agentOf(env),
    migratorUrls: Object.fromEntries(SERVICES.map((svc) => [svc, env[migratorEnv(svc)] ?? ''])) as Record<Service, string>,
  });
};

export const withEmailA = (data: SeedData, email: string | null): SeedData =>
  email === null ? data : { ...data, appUsers: data.appUsers.map((u) => (u.user_id === userId('A') ? { ...u, email } : u)) };

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

export type AwsSeedResult = { readonly changed: InsertedCounts; readonly agent: AgentStatus | null };

// Bootstrap and migrations are their own tasks in AWS; this only provisions identities and inserts rows.
export const runAwsSeed =
  (deps: AwsSeedDeps) =>
  async (data: SeedData, agent: SeedAgent | null = null): Promise<Result<AwsSeedResult, AwsSeedError>> => {
    const provisioned = await provisionSeedUsers(deps.provision)(seedUsers(data));
    if (!provisioned.ok) return provisioned;
    const mapped = withCognitoSubs(data, provisioned.value.subs);
    if (!mapped.ok) return mapped;
    // Mock-issuer agent subs mean nothing to Cognito; a dev agent comes only from SEED_AGENT_*.
    const inserted = await insertAll({ ...mapped.value, agentIdentities: [] }, deps.urlFor);
    if (!inserted.ok) return inserted;
    const changed = { ...provisioned.value.counts, ...inserted.value };
    if (agent === null) return ok({ changed, agent: null });
    const provisionedAgent = await provisionAgent(deps)(agent, data.authIdentities.map((i) => i.username));
    if (!provisionedAgent.ok) return provisionedAgent;
    return ok({ changed: { ...changed, ...provisionedAgent.value.counts }, agent: provisionedAgent.value.agent });
  };
