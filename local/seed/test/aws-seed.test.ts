import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, SERVICES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { provisionAgent, TOTP_ENROLL_ACTION, type SeedAgent } from '../src/agent.ts';
import { runAwsSeed, withEmailA, type AwsSeedDeps } from '../src/aws-seed.ts';
import { DEFAULT_SEED, generateSeedData, userId } from '../src/generate.ts';
import { generatePassword } from '../src/password.ts';
import type { UrlFor } from '../src/seed.ts';
import { parseSeedUserSecret } from '../src/seed-user-secret.ts';
import { fakeAws, MUTATING, type FakeAws } from './fake-aws.ts';

const passwords = Object.fromEntries(ROLES.map((r) => [r, `fake-${r}-password-0002`])) as Record<Role, string>;
const data = generateSeedData({ seed: DEFAULT_SEED, now: new Date('2026-10-19T09:30:00Z') });
const backendDir = fileURLToPath(new URL('../../../backend', import.meta.url));

let pgc: TestPostgres;
let urlFor: UrlFor;

const roleUrl = (admin: string, role: Role): string => {
  const url = new URL(admin);
  url.username = role;
  url.password = passwords[role];
  return url.toString();
};

const adminQuery = async (sql: string): Promise<pg.QueryResult> => {
  const client = new pg.Client({ connectionString: pgc.connectionString });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
};

const seedDeps = (aws: FakeAws, rotatePasswords = false): AwsSeedDeps => ({
  provision: {
    cognito: aws.cognito,
    secrets: aws.secretsManager,
    userPoolId: 'eu-north-1_FAKEPOOL',
    secretPrefix: 'cd/dev/seed-users/',
    kmsKeyId: 'arn:aws:kms:eu-north-1:111122223333:key/0b7c9a3e-1111-4222-8333-444455556666',
    rotatePasswords,
    newPassword: () => generatePassword(),
  },
  urlFor,
});

// The AWS path never bootstraps or migrates, so the test prepares the database the way the db-bootstrap and migrate tasks do.
beforeAll(async () => {
  pgc = await startTestPostgres();
  const boot = await bootstrap({ adminConnectionString: pgc.connectionString, passwords });
  expect(boot.ok).toBe(true);
  urlFor = (svc) => roleUrl(pgc.connectionString, `${svc}_migrator`);
  for (const schema of SERVICES) {
    const migrated = await migrate({ schema, dir: join(backendDir, schema, 'migrations'), connectionString: urlFor(schema) });
    expect(migrated.ok).toBe(true);
  }
});

afterAll(async () => {
  await pgc?.stop();
});

const aws = fakeAws();

describe('runAwsSeed against Postgres 18 with Cognito stubbed', () => {

  it('writes auth_identity with the sub Cognito issued for each username, then a second run changes 0 rows and creates 0 users', async () => {
    const first = await runAwsSeed(seedDeps(aws))(data);
    expect(first).toMatchObject({
      ok: true,
      value: {
        agent: null,
        changed: {
          cognito_user_created: 4,
          cognito_user_disabled: 1,
          seed_secret_created: 4,
          app_user: 4,
          auth_identity: 4,
          agent_identity: 0,
          transaction: data.transactions.length,
          dispute: 4,
        },
      },
    });
    const stored = await adminQuery('select username, cognito_sub, status from auth.auth_identity order by username');
    expect(stored.rows).toEqual(
      [...aws.users]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([username, u]) => ({ username, cognito_sub: u.sub, status: u.enabled ? 'ACTIVE' : 'DISABLED' })),
    );
    expect(stored.rows.map((r) => r.cognito_sub)).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect((await adminQuery('select count(*)::int as n from auth.agent_identity')).rows).toEqual([{ n: 0 }]);
    expect(aws.commands()).not.toContain('AdminAddUserToGroupCommand');

    aws.calls.length = 0;
    const second = await runAwsSeed(seedDeps(aws))(data);
    expect(second.ok && Object.entries(second.value.changed).filter(([, n]) => n !== 0)).toEqual([]);
    expect(aws.commands().filter((c) => (MUTATING as ReadonlyArray<string>).includes(c))).toEqual([]);
  });

  it('SEED_A_EMAIL sets the app_user email and Cognito attribute; a repeat changes 0 rows; a new value updates both again', async () => {
    const emailOfA = async (): Promise<unknown> =>
      (await adminQuery(`select email::text as email from users.app_user where user_id = '${userId('A')}'`)).rows[0]?.email;
    const changes = async (email: string) => {
      const result = await runAwsSeed(seedDeps(aws))(withEmailA(data, email));
      expect(result.ok).toBe(true);
      return result.ok ? Object.fromEntries(Object.entries(result.value.changed).filter(([, n]) => n !== 0)) : {};
    };

    expect(await changes('thandi.owner@example.test')).toEqual({ app_user_email_updated: 1, cognito_email_updated: 1 });
    expect(await emailOfA()).toBe('thandi.owner@example.test');
    expect(aws.users.get('thandi.nkosi')?.email).toBe('thandi.owner@example.test');

    aws.calls.length = 0;
    expect(await changes('thandi.owner@example.test')).toEqual({});
    expect(aws.commands().filter((c) => (MUTATING as ReadonlyArray<string>).includes(c))).toEqual([]);

    expect(await changes('Thandi.Owner@example.test')).toEqual({ app_user_email_updated: 1, cognito_email_updated: 1 });
    expect(await emailOfA()).toBe('Thandi.Owner@example.test');
    expect(aws.users.get('thandi.nkosi')?.email).toBe('Thandi.Owner@example.test');
    const others = await adminQuery(`select count(*)::int as n from users.app_user where email::text like '%@example.com'`);
    expect(others.rows[0]?.n).toBe(3);
  });

  it('refuses to keep a stale auth_identity when Cognito now issues a different sub for the username', async () => {
    const recreated = fakeAws();
    const result = await runAwsSeed(seedDeps(recreated))(data);
    expect(result).toMatchObject({ ok: false, error: { kind: 'insert', schema: 'auth' } });
    expect(!result.ok && 'message' in result.error && result.error.message).toContain('thandi.nkosi');
  });
});

describe('runAwsSeed with SEED_AGENT_* set', () => {
  const agent: SeedAgent = {
    username: 'agent.naledi.dev',
    email: 'naledi.agent@example.com',
    displayName: 'Naledi M.',
    requireTotp: false,
    secretPrefix: 'cd/dev/agent-users/',
  };
  const nonZero = (counts: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(counts).filter(([, n]) => n !== 0));
  const agentRows = async () =>
    (
      await adminQuery(
        'select cognito_sub, display_name, status from auth.agent_identity order by created_at',
      )
    ).rows;
  const mutations = () => aws.commands().filter((c) => (MUTATING as ReadonlyArray<string>).includes(c));

  beforeAll(async () => {
    expect((await runAwsSeed(seedDeps(aws))(data)).ok).toBe(true);
  });

  it('creates the Cognito user with a verified email, stores its password, adds it to agents and writes an ACTIVE agent_identity once', async () => {
    aws.calls.length = 0;
    const first = await runAwsSeed(seedDeps(aws))(data, agent);
    expect(first.ok && nonZero(first.value.changed)).toEqual({
      agent_cognito_user_created: 1,
      agent_cognito_password_set: 1,
      agent_seed_secret_created: 1,
      agent_identity_created: 1,
    });
    expect(first.ok && first.value.agent).toEqual({ status: 'ACTIVE', totp: 'not_enabled' });
    const user = aws.users.get(agent.username);
    expect(user).toMatchObject({
      email: agent.email,
      enabled: true,
      status: 'CONFIRMED',
      groups: new Set(['agents']),
    });
    expect(aws.calls.find((c) => c.command === 'AdminCreateUserCommand')?.input).toMatchObject({
      Username: agent.username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: agent.email },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    expect(aws.calls.find((c) => c.command === 'AdminAddUserToGroupCommand')?.input).toEqual({
      UserPoolId: 'eu-north-1_FAKEPOOL',
      Username: agent.username,
      GroupName: 'agents',
    });
    expect(aws.secrets.has(`cd/dev/seed-users/${agent.username}`)).toBe(false);
    expect(parseSeedUserSecret(aws.secrets.get(`cd/dev/agent-users/${agent.username}`)?.value)).toEqual({
      username: agent.username,
      password: user?.password,
    });
    expect(await agentRows()).toEqual([
      { cognito_sub: user?.sub, display_name: 'Naledi M.', status: 'ACTIVE' },
    ]);

    aws.calls.length = 0;
    const second = await runAwsSeed(seedDeps(aws))(data, agent);
    expect(second.ok && nonZero(second.value.changed)).toEqual({});
    // AdminAddUserToGroup is re-sent every run because it is idempotent and membership is not readable with the granted actions.
    expect(mutations()).toEqual(['AdminAddUserToGroupCommand']);
    expect(await agentRows()).toEqual([
      { cognito_sub: user?.sub, display_name: 'Naledi M.', status: 'ACTIVE' },
    ]);
  });

  it('renames an ACTIVE agent when SEED_AGENT_DISPLAY_NAME changes', async () => {
    const renamed = await runAwsSeed(seedDeps(aws))(data, { ...agent, displayName: 'Naledi Mokoena' });
    expect(renamed.ok && nonZero(renamed.value.changed)).toEqual({ agent_identity_renamed: 1 });
    expect((await agentRows()).map((r) => r.display_name)).toEqual(['Naledi Mokoena']);
  });

  it('SEED_AGENT_REQUIRE_TOTP fails with the enrolment action until the agent has verified a token, then enables and prefers TOTP once', async () => {
    const required = { ...agent, displayName: 'Naledi Mokoena', requireTotp: true };
    expect(await runAwsSeed(seedDeps(aws))(data, required)).toMatchObject({
      ok: false,
      error: {
        kind: 'provision',
        step: 'AdminSetUserMFAPreference',
        name: 'InvalidParameterException',
        action: TOTP_ENROLL_ACTION,
      },
    });

    const user = aws.users.get(agent.username);
    if (user) user.totpVerified = true;
    aws.calls.length = 0;
    const enabled = await runAwsSeed(seedDeps(aws))(data, required);
    expect(enabled.ok && nonZero(enabled.value.changed)).toEqual({ agent_totp_enabled: 1 });
    expect(enabled.ok && enabled.value.agent).toEqual({ status: 'ACTIVE', totp: 'enabled' });
    expect(aws.calls.find((c) => c.command === 'AdminSetUserMFAPreferenceCommand')?.input).toMatchObject({
      Username: agent.username,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });

    aws.calls.length = 0;
    const repeat = await runAwsSeed(seedDeps(aws))(data, required);
    expect(repeat.ok && repeat.value.agent).toEqual({ status: 'ACTIVE', totp: 'enabled' });
    expect(aws.commands()).not.toContain('AdminSetUserMFAPreferenceCommand');
  });

  it('leaves an offboarded (DISABLED) agent untouched: no Cognito write, no group re-add, row stays DISABLED, even when rotating passwords', async () => {
    await adminQuery(`update auth.agent_identity set status = 'DISABLED'`);
    aws.users.get(agent.username)?.groups.delete('agents');
    try {
      aws.calls.length = 0;
      const result = await runAwsSeed(seedDeps(aws, true))(data, { ...agent, displayName: 'Someone Else' });
      expect(result.ok && result.value.agent).toEqual({ status: 'DISABLED', totp: 'enabled' });
      expect(
        aws.calls.filter((c) => c.input.Username === agent.username && c.command !== 'AdminGetUserCommand'),
      ).toEqual([]);
      expect(aws.users.get(agent.username)?.groups.size).toBe(0);
      expect((await agentRows()).map((r) => [r.display_name, r.status])).toEqual([
        ['Naledi Mokoena', 'DISABLED'],
      ]);
    } finally {
      await adminQuery(`update auth.agent_identity set status = 'ACTIVE'`);
      aws.users.get(agent.username)?.groups.add('agents');
    }
  });

  it('refuses a seeded customer username as the agent before touching Cognito for it', async () => {
    aws.calls.length = 0;
    const result = await runAwsSeed(seedDeps(aws))(data, { ...agent, username: 'thandi.nkosi' });
    expect(result).toEqual({ ok: false, error: { kind: 'ambiguous_role', username: 'thandi.nkosi' } });
    expect(mutations()).toEqual([]);
    expect(aws.users.get('thandi.nkosi')?.groups.size).toBe(0);
  });

  it('refuses an existing Cognito user whose sub is a customer in auth_identity, with no Cognito write and no agent row', async () => {
    const customerSub = aws.users.get('sipho.dlamini')?.sub ?? '';
    aws.users.set('agent.alias', {
      sub: customerSub,
      enabled: true,
      status: 'CONFIRMED',
      password: null,
      email: 'sipho.dlamini@example.com',
      groups: new Set(),
      totpVerified: false,
      totpEnabled: false,
    });
    aws.calls.length = 0;
    const result = await runAwsSeed(seedDeps(aws))(data, { ...agent, username: 'agent.alias' });
    expect(result).toEqual({ ok: false, error: { kind: 'ambiguous_role', username: 'agent.alias' } });
    expect(mutations()).toEqual([]);
    expect(
      (
        await adminQuery(
          `select count(*)::int as n from auth.agent_identity where cognito_sub = '${customerSub}'`,
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  const customerRow = (username: string) =>
    adminQuery(
      `insert into auth.auth_identity (cognito_sub, username, user_id) values ('${username}-sub', '${username}', gen_random_uuid())`,
    );

  it('refuses a username that is already a customer in auth_identity even when Cognito has no such user, before any Cognito write', async () => {
    await customerRow('ghost.customer');
    aws.calls.length = 0;
    const result = await runAwsSeed(seedDeps(aws))(data, { ...agent, username: 'ghost.customer' });
    expect(result).toEqual({ ok: false, error: { kind: 'ambiguous_role', username: 'ghost.customer' } });
    expect(mutations()).toEqual([]);
    expect(aws.users.has('ghost.customer')).toBe(false);
  });

  it('re-checks inside the agent_identity transaction: a customer row that appears during provisioning → ambiguous_role, no agent row, no group add', async () => {
    const racing: FakeAws = {
      ...aws,
      cognito: {
        send: async (command: unknown) => {
          if (command instanceof AdminCreateUserCommand && command.input.Username === 'race.customer') {
            await customerRow('race.customer');
          }
          return aws.cognito.send(command as never);
        },
      } as FakeAws['cognito'],
    };
    aws.calls.length = 0;
    const result = await runAwsSeed(seedDeps(racing))(data, { ...agent, username: 'race.customer' });
    expect(result).toEqual({ ok: false, error: { kind: 'ambiguous_role', username: 'race.customer' } });
    expect(aws.commands()).not.toContain('AdminAddUserToGroupCommand');
    const sub = aws.users.get('race.customer')?.sub ?? '';
    expect((await adminQuery(`select count(*)::int as n from auth.agent_identity where cognito_sub = '${sub}'`)).rows).toEqual([
      { n: 0 },
    ]);
  });

  it('adds the group only after the agent row is written: a failing agent_identity write → agent_db and no AdminAddUserToGroup', async () => {
    // auth_app may read both identity tables but has no INSERT on agent_identity, so only the row write fails.
    const readOnlyAuth: UrlFor = (svc) => (svc === 'auth' ? roleUrl(pgc.connectionString, 'auth_app') : urlFor(svc));
    aws.calls.length = 0;
    const result = await provisionAgent({ provision: seedDeps(aws).provision, urlFor: readOnlyAuth })(
      { ...agent, username: 'agent.nodb' },
      [],
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'agent_db' } });
    expect(!result.ok && 'message' in result.error && result.error.message).toContain('permission denied');
    expect(aws.commands()).toContain('AdminCreateUserCommand');
    expect(aws.commands()).not.toContain('AdminAddUserToGroupCommand');
    expect(aws.users.get('agent.nodb')?.groups.size).toBe(0);
  });
});
