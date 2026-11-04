import {
  AdminAddUserToGroupCommand,
  AdminSetUserMFAPreferenceCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { withTransaction } from '@cd/db';
import { err, ok, type Result } from '@cd/shared/fp';
import type pg from 'pg';
import {
  attempt,
  findCognitoUser,
  provisionSeedUsers,
  type CognitoUser,
  type ProvisionDeps,
  type ProvisionError,
} from './cognito.ts';
import { messageOf, withPool, type InsertedCounts, type UrlFor } from './seed.ts';

export const AGENTS_GROUP = 'agents';
const TOTP = 'SOFTWARE_TOKEN_MFA';

export const TOTP_ENROLL_ACTION =
  'the agent has no verified TOTP authenticator yet; they enrol it after signing in, then re-run dev-seed with SEED_AGENT_REQUIRE_TOTP=true';

export type SeedAgent = {
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  readonly requireTotp: boolean;
  readonly secretPrefix: string;
};

export type AgentStatus = {
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly totp: 'enabled' | 'not_enabled';
};

export type AgentProvisioned = { readonly counts: InsertedCounts; readonly agent: AgentStatus };

export type AgentError =
  | ProvisionError
  | { readonly kind: 'ambiguous_role'; readonly username: string }
  | { readonly kind: 'agent_db'; readonly message: string };

export type AgentDeps = { readonly provision: ProvisionDeps; readonly urlFor: UrlFor };

type Roles = {
  readonly customer: boolean;
  readonly agentStatus: 'ACTIVE' | 'DISABLED' | null;
  readonly displayName: string | null;
};

const SQL = {
  roles: `
    select exists (select 1 from auth.auth_identity where cognito_sub = $1::text or username = $2) as customer,
      a.status as agent_status, a.display_name
    from (select 1) one left join auth.agent_identity a on a.cognito_sub = $1::text`,
  insert: `
    insert into auth.agent_identity (cognito_sub, display_name) values ($1, $2)
    on conflict (cognito_sub) do nothing`,
  rename: `update auth.agent_identity set display_name = $2 where cognito_sub = $1 and status = 'ACTIVE'`,
} as const;

const readRoles = async (client: pg.ClientBase, sub: string | null, username: string): Promise<Roles> => {
  const row = (
    await client.query<{
      customer: boolean;
      agent_status: 'ACTIVE' | 'DISABLED' | null;
      display_name: string | null;
    }>(SQL.roles, [sub, username])
  ).rows[0];
  return {
    customer: row?.customer ?? false,
    agentStatus: row?.agent_status ?? null,
    displayName: row?.display_name ?? null,
  };
};

const inAuth = async <T>(
  deps: AgentDeps,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<Result<T, AgentError>> => {
  try {
    return ok(await withPool(deps.urlFor('auth'), (pool) => withTransaction(pool, fn)));
  } catch (e) {
    return err({ kind: 'agent_db', message: messageOf(e) });
  }
};

type Upserted = { readonly roles: Roles; readonly created: number; readonly renamed: number };

// Rows are only ever created ACTIVE; a DISABLED row is the offboarding switch and the seed never flips it back.
const upsertAgent = (deps: AgentDeps, sub: string, agent: SeedAgent) =>
  inAuth<Upserted>(deps, async (client) => {
    const roles = await readRoles(client, sub, agent.username);
    if (roles.customer || roles.agentStatus === 'DISABLED') return { roles, created: 0, renamed: 0 };
    if (roles.agentStatus === null) {
      const created = (await client.query(SQL.insert, [sub, agent.displayName])).rowCount ?? 0;
      return { roles: { ...roles, agentStatus: 'ACTIVE' }, created, renamed: 0 };
    }
    const renamed =
      roles.displayName === agent.displayName
        ? 0
        : ((await client.query(SQL.rename, [sub, agent.displayName])).rowCount ?? 0);
    return { roles, created: 0, renamed };
  });

const totpOf = (user: CognitoUser | null): AgentStatus['totp'] =>
  user !== null && user.mfaEnabled.includes(TOTP) && user.preferredMfa === TOTP ? 'enabled' : 'not_enabled';

// Membership is not read first: AdminAddUserToGroup is idempotent and keeps the IAM grant to this one action.
const addToGroup = (deps: ProvisionDeps, username: string) =>
  attempt(username, 'AdminAddUserToGroup', () =>
    deps.cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
        GroupName: AGENTS_GROUP,
      }),
    ),
  );

// Cognito refuses this until the user has verified a software token, which only the user's own session can do.
const enableTotp = async (
  deps: ProvisionDeps,
  username: string,
): Promise<Result<unknown, ProvisionError>> => {
  const set = await attempt(username, 'AdminSetUserMFAPreference', () =>
    deps.cognito.send(
      new AdminSetUserMFAPreferenceCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
        SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
      }),
    ),
  );
  return !set.ok && set.error.name === 'InvalidParameterException'
    ? err({ ...set.error, action: TOTP_ENROLL_ACTION })
    : set;
};

const prefixed = (counts: InsertedCounts): InsertedCounts =>
  Object.fromEntries(Object.entries(counts).map(([k, n]) => [`agent_${k}`, n]));

const ambiguous = (username: string): AgentError => ({ kind: 'ambiguous_role', username });

export const provisionAgent =
  (deps: AgentDeps) =>
  async (
    agent: SeedAgent,
    customerUsernames: ReadonlyArray<string>,
  ): Promise<Result<AgentProvisioned, AgentError>> => {
    if (customerUsernames.includes(agent.username)) return err(ambiguous(agent.username));
    const existing = await findCognitoUser(deps.provision, agent.username);
    if (!existing.ok) return existing;
    // Checked before any Cognito write so a customer login is never touched and an offboarded agent never re-provisioned.
    const known = existing.value;
    const roles = await inAuth(deps, (client) => readRoles(client, known?.sub ?? null, agent.username));
    if (!roles.ok) return roles;
    if (roles.value.customer) return err(ambiguous(agent.username));
    if (roles.value.agentStatus === 'DISABLED')
      return ok({ counts: {}, agent: { status: 'DISABLED', totp: totpOf(known) } });

    // Agent passwords live under their own prefix because the e2e role can read every customer seed secret.
    const provisioned = await provisionSeedUsers({ ...deps.provision, secretPrefix: agent.secretPrefix })([
      { username: agent.username, email: agent.email, disabled: false },
    ]);
    if (!provisioned.ok) return provisioned;
    const sub = provisioned.value.subs.get(agent.username);
    if (sub === undefined)
      return err({ kind: 'provision', username: agent.username, step: 'AdminGetUser', name: 'MissingSub' });

    const row = await upsertAgent(deps, sub, agent);
    if (!row.ok) return row;
    if (row.value.roles.customer) return err(ambiguous(agent.username));
    const counts = {
      ...prefixed(provisioned.value.counts),
      agent_identity_created: row.value.created,
      agent_identity_renamed: row.value.renamed,
    };
    const totp = totpOf(existing.value);
    if (row.value.roles.agentStatus === 'DISABLED')
      return ok({ counts, agent: { status: 'DISABLED', totp } });

    const grouped = await addToGroup(deps.provision, agent.username);
    if (!grouped.ok) return grouped;

    if (!agent.requireTotp || totp === 'enabled')
      return ok({ counts: { ...counts, agent_totp_enabled: 0 }, agent: { status: 'ACTIVE', totp } });
    const enabled = await enableTotp(deps.provision, agent.username);
    if (!enabled.ok) return enabled;
    return ok({ counts: { ...counts, agent_totp_enabled: 1 }, agent: { status: 'ACTIVE', totp: 'enabled' } });
  };
