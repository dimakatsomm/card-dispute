import { describe, expect, it } from 'vitest';
import { isPlausibleEmail, resolveAwsSeedConfig, seedUsers, withCognitoSubs, withEmailA } from '../src/aws-seed.ts';
import { provisionSeedUsers, ROTATE_ACTION, type ProvisionDeps } from '../src/cognito.ts';
import { DEFAULT_SEED, generateSeedData, userId } from '../src/generate.ts';
import { generatePassword } from '../src/password.ts';
import { parseSeedUserSecret } from '../src/seed-user-secret.ts';
import { fakeAws, MUTATING, type FakeAws } from './fake-aws.ts';

const KMS = 'arn:aws:kms:eu-north-1:111122223333:key/0b7c9a3e-1111-4222-8333-444455556666';
const PREFIX = 'cd/dev/seed-users/';
const data = generateSeedData({ seed: DEFAULT_SEED, now: new Date('2026-10-19T09:30:00Z') });
const users = seedUsers(data);

const deps = (aws: FakeAws, overrides: Partial<ProvisionDeps> = {}): ProvisionDeps => ({
  cognito: aws.cognito,
  secrets: aws.secretsManager,
  userPoolId: 'eu-north-1_FAKEPOOL',
  secretPrefix: PREFIX,
  kmsKeyId: KMS,
  rotatePasswords: false,
  newPassword: () => generatePassword(),
  ...overrides,
});

const mutations = (aws: FakeAws): ReadonlyArray<string> =>
  aws.commands().filter((c) => (MUTATING as ReadonlyArray<string>).includes(c));

describe('provisionSeedUsers (Cognito + Secrets Manager behind an SDK stub)', () => {
  it('creates A-D suppressed with a verified email, sets a permanent policy-compliant password, disables D, and stores each password', async () => {
    const aws = fakeAws();
    const result = await provisionSeedUsers(deps(aws))(users);

    expect(result.ok && result.value.counts).toEqual({
      cognito_user_created: 4,
      cognito_user_disabled: 1,
      cognito_email_updated: 0,
      cognito_password_set: 4,
      seed_secret_created: 4,
      seed_secret_updated: 0,
    });
    expect([...aws.users.keys()].sort()).toEqual(['dumisani.zulu', 'lerato.mokoena', 'sipho.dlamini', 'thandi.nkosi']);
    expect(aws.users.get('dumisani.zulu')?.enabled).toBe(false);
    expect([...aws.users.entries()].filter(([, u]) => !u.enabled).map(([n]) => n)).toEqual(['dumisani.zulu']);

    const create = aws.calls.find((c) => c.command === 'AdminCreateUserCommand' && c.input.Username === 'thandi.nkosi');
    expect(create?.input).toMatchObject({
      UserPoolId: 'eu-north-1_FAKEPOOL',
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: 'thandi.nkosi@example.com' },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    for (const call of aws.calls.filter((c) => c.command === 'AdminSetUserPasswordCommand')) {
      expect(call.input.Permanent).toBe(true);
      expect(String(call.input.Password)).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{14,}$/);
    }

    for (const [username, user] of aws.users) {
      const secret = aws.secrets.get(`${PREFIX}${username}`);
      expect(secret?.kmsKeyId).toBe(KMS);
      expect(secret?.tags).toBeUndefined();
      expect(parseSeedUserSecret(secret?.value)).toEqual({ username, password: user.password });
      expect(user.status).toBe('CONFIRMED');
    }
    for (const call of aws.calls.filter((c) => c.command === 'CreateSecretCommand')) {
      expect(Object.keys(call.input).sort()).toEqual(['KmsKeyId', 'Name', 'SecretString']);
    }

    expect(result.ok && Object.fromEntries(result.value.subs)).toEqual(
      Object.fromEntries([...aws.users].map(([name, u]) => [name, u.sub])),
    );
  });

  it('a second run creates nothing, sets no password and writes no secret; the subs stay the same', async () => {
    const aws = fakeAws();
    const first = await provisionSeedUsers(deps(aws))(users);
    const secretsBefore = new Map([...aws.secrets].map(([k, v]) => [k, v.value]));
    aws.calls.length = 0;

    const second = await provisionSeedUsers(deps(aws))(users);

    expect(second.ok && second.value.counts).toEqual({
      cognito_user_created: 0,
      cognito_user_disabled: 0,
      cognito_email_updated: 0,
      cognito_password_set: 0,
      seed_secret_created: 0,
      seed_secret_updated: 0,
    });
    expect(mutations(aws)).toEqual([]);
    expect(aws.commands().filter((c) => c === 'GetSecretValueCommand')).toEqual([]);
    expect(new Map([...aws.secrets].map(([k, v]) => [k, v.value]))).toEqual(secretsBefore);
    expect(second.ok && first.ok && Object.fromEntries(second.value.subs)).toEqual(first.ok && Object.fromEntries(first.value.subs));
  });

  it('reuses a surviving secret for a recreated user (no PutSecretValue) and regenerates a lost one', async () => {
    const aws = fakeAws();
    await provisionSeedUsers(deps(aws))(users);
    const kept = aws.secrets.get(`${PREFIX}thandi.nkosi`)?.value;
    aws.users.delete('thandi.nkosi');
    aws.secrets.delete(`${PREFIX}sipho.dlamini`);
    aws.calls.length = 0;

    const result = await provisionSeedUsers(deps(aws))(users);

    expect(result.ok && result.value.counts).toMatchObject({ cognito_user_created: 1, cognito_password_set: 2, seed_secret_created: 1, seed_secret_updated: 0 });
    expect(aws.secrets.get(`${PREFIX}thandi.nkosi`)?.value).toBe(kept);
    expect(aws.users.get('thandi.nkosi')?.password).toBe(parseSeedUserSecret(kept)?.password);
    expect(parseSeedUserSecret(aws.secrets.get(`${PREFIX}sipho.dlamini`)?.value)?.password).toBe(aws.users.get('sipho.dlamini')?.password);
  });

  it('rotates only when asked, writing each changed password with PutSecretValue', async () => {
    const aws = fakeAws();
    await provisionSeedUsers(deps(aws))(users);
    aws.calls.length = 0;
    const result = await provisionSeedUsers(deps(aws, { rotatePasswords: true }))(users);
    expect(result.ok && result.value.counts).toMatchObject({ cognito_password_set: 4, seed_secret_created: 0, seed_secret_updated: 4 });
    expect(aws.commands()).not.toContain('CreateSecretCommand');
  });

  it('stops with the SDK error name when Secrets Manager refuses, and leaves no secret Cognito does not accept', async () => {
    const aws = fakeAws();
    const refusing = {
      send: async (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === 'CreateSecretCommand') {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return aws.secretsManager.send(command as never);
      },
    } as unknown as ProvisionDeps['secrets'];
    const result = await provisionSeedUsers(deps(aws, { secrets: refusing }))(users);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'provision', username: 'thandi.nkosi', step: 'CreateSecret', name: 'AccessDeniedException' },
    });
    expect(aws.secrets.size).toBe(0);
  });
});

describe('provisionSeedUsers when PutSecretValue fails after the password was set', () => {
  it('stops with a step naming the drift and the rotate instruction, carrying no secret content', async () => {
    const aws = fakeAws();
    await provisionSeedUsers(deps(aws))(users);
    const refusingPut = {
      send: async (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === 'PutSecretValueCommand') {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return aws.secretsManager.send(command as never);
      },
    } as unknown as ProvisionDeps['secrets'];

    const result = await provisionSeedUsers(deps(aws, { secrets: refusingPut, rotatePasswords: true }))(users);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'provision',
        username: 'thandi.nkosi',
        step: 'PutSecretValueAfterPasswordSet',
        name: 'AccessDeniedException',
        action: ROTATE_ACTION,
      },
    });
    expect(ROTATE_ACTION).toContain('SEED_ROTATE_USER_PASSWORDS=true');
    expect(JSON.stringify(result)).not.toContain(aws.users.get('thandi.nkosi')?.password ?? '<none>');
  });
});

describe('auth_identity mapping', () => {
  it('replaces every placeholder sub with the sub Cognito issued for that username', () => {
    const subs = new Map(users.map((u, i) => [u.username, `real-sub-${i}`]));
    const mapped = withCognitoSubs(data, subs);
    expect(mapped.ok && mapped.value.authIdentities.map((i) => [i.username, i.cognito_sub])).toEqual(
      users.map((u, i) => [u.username, `real-sub-${i}`]),
    );
    expect(withCognitoSubs(data, new Map())).toEqual({ ok: false, error: { kind: 'unprovisioned', username: 'thandi.nkosi' } });
  });
});

describe('resolveAwsSeedConfig', () => {
  const url = (svc: string, query = '?sslmode=verify-full'): string =>
    `postgres://${svc}_migrator:fake-pass@cd-dev.cluster-x.eu-north-1.rds.amazonaws.com:5432/disputes${query}`;
  const env = {
    COGNITO_USER_POOL_ID: 'eu-north-1_FAKEPOOL',
    SEED_USER_SECRET_PREFIX: PREFIX,
    SEED_USER_SECRET_KMS_KEY_ID: KMS,
    DB_HOST: 'cd-dev.cluster-x.eu-north-1.rds.amazonaws.com',
    DB_PORT: '5432',
    DB_NAME: 'disputes',
    MIGRATOR_DATABASE_URL_AUTH: url('auth'),
    MIGRATOR_DATABASE_URL_USERS: url('users'),
    MIGRATOR_DATABASE_URL_TRANSACTIONS: url('transactions'),
    MIGRATOR_DATABASE_URL_DISPUTES: url('disputes'),
  };

  it('reads the four migrator URLs from MIGRATOR_DATABASE_URL_<SCHEMA>', () => {
    const config = resolveAwsSeedConfig(env);
    expect(config.ok && config.value.migratorUrls).toEqual({
      auth: url('auth'),
      users: url('users'),
      transactions: url('transactions'),
      disputes: url('disputes'),
    });
    expect(config.ok && config.value.rotatePasswords).toBe(false);
  });

  it.each(['?sslmode=verify-full&sslrootcert=/tmp/ca.pem', '?sslmode=verify-full&uselibpqcompat=true', '?sslmode=verify-full&sslmode=disable'])(
    'refuses a verify-full URL that carries any other parameter (%s)',
    (query) => {
      expect(resolveAwsSeedConfig({ ...env, MIGRATOR_DATABASE_URL_TRANSACTIONS: url('transactions', query) })).toEqual({
        ok: false,
        error: { missing: [], invalid: ['MIGRATOR_DATABASE_URL_TRANSACTIONS'] },
      });
    },
  );

  it('refuses a URL without verify-full, for another schema or another host, and names only the variables', () => {
    const config = resolveAwsSeedConfig({
      ...env,
      MIGRATOR_DATABASE_URL_AUTH: url('auth', '?sslmode=require'),
      MIGRATOR_DATABASE_URL_USERS: url('auth'),
      MIGRATOR_DATABASE_URL_DISPUTES: url('disputes').replace('cd-dev.cluster-x', 'elsewhere'),
      SEED_USER_SECRET_KMS_KEY_ID: 'alias/cd-data',
    });
    expect(config).toEqual({
      ok: false,
      error: {
        missing: [],
        invalid: ['SEED_USER_SECRET_KMS_KEY_ID', 'MIGRATOR_DATABASE_URL_AUTH', 'MIGRATOR_DATABASE_URL_USERS', 'MIGRATOR_DATABASE_URL_DISPUTES'],
      },
    });
    expect(resolveAwsSeedConfig({ ...env, MIGRATOR_DATABASE_URL_AUTH: url('auth').replace('postgres:', 'postgresql:') }).ok).toBe(true);
    expect(resolveAwsSeedConfig({})).toMatchObject({ ok: false, error: { missing: expect.arrayContaining(['MIGRATOR_DATABASE_URL_AUTH']) } });
  });
});

describe('SEED_A_EMAIL', () => {
  const CUSTOM = 'thandi.owner@example.test';
  const env = {
    COGNITO_USER_POOL_ID: 'eu-north-1_FAKEPOOL',
    SEED_USER_SECRET_PREFIX: PREFIX,
    SEED_USER_SECRET_KMS_KEY_ID: KMS,
    DB_HOST: 'cd-dev.cluster-x.eu-north-1.rds.amazonaws.com',
    DB_PORT: '5432',
    DB_NAME: 'disputes',
    ...Object.fromEntries(
      ['auth', 'users', 'transactions', 'disputes'].map((svc) => [
        `MIGRATOR_DATABASE_URL_${svc.toUpperCase()}`,
        `postgres://${svc}_migrator:fake-pass@cd-dev.cluster-x.eu-north-1.rds.amazonaws.com:5432/disputes?sslmode=verify-full`,
      ]),
    ),
  };

  it.each([
    [undefined, null],
    ['', null],
    [CUSTOM, CUSTOM],
    ["o'brien+e2e@mail.example.test", "o'brien+e2e@mail.example.test"],
  ])('accepts %j as emailA %j', (value, emailA) => {
    const config = resolveAwsSeedConfig({ ...env, SEED_A_EMAIL: value });
    expect(config.ok && config.value.emailA).toBe(emailA);
  });

  it.each([
    'thandi',
    'thandi@',
    '@example.test',
    'thandi@example',
    'thandi owner@example.test',
    'thandi@exa mple.test',
    'a@b@example.test',
    '.thandi@example.test',
    'thandi..owner@example.test',
    'thandi@-example.test',
    'Thandi <thandi@example.test>',
    'thandi@example.test\n',
    `${'a'.repeat(65)}@example.test`,
    `thandi@${`${'a'.repeat(60)}.`.repeat(4)}test`,
  ])('rejects %j, naming only the variable and never echoing the value', (value) => {
    expect(isPlausibleEmail(value)).toBe(false);
    const config = resolveAwsSeedConfig({ ...env, SEED_A_EMAIL: value });
    expect(config).toEqual({ ok: false, error: { missing: [], invalid: ['SEED_A_EMAIL'] } });
  });

  it('overrides only user A, so Cognito and app_user both get the custom address', () => {
    const custom = withEmailA(data, CUSTOM);
    expect(custom.appUsers.filter((u) => u.email === CUSTOM).map((u) => u.user_id)).toEqual([userId('A')]);
    expect(custom.appUsers.filter((u) => u.user_id !== userId('A'))).toEqual(data.appUsers.filter((u) => u.user_id !== userId('A')));
    expect(seedUsers(custom).find((u) => u.username === 'thandi.nkosi')?.email).toBe(CUSTOM);
    expect(withEmailA(data, null)).toBe(data);
  });

  it('a new value updates only A in Cognito (verified), a repeat changes nothing, and unsetting restores the generated address', async () => {
    const aws = fakeAws();
    await provisionSeedUsers(deps(aws))(users);
    aws.calls.length = 0;

    const changed = await provisionSeedUsers(deps(aws))(seedUsers(withEmailA(data, CUSTOM)));
    expect(changed.ok && changed.value.counts).toMatchObject({ cognito_email_updated: 1, cognito_user_created: 0, cognito_password_set: 0 });
    expect(aws.calls.filter((c) => c.command === 'AdminUpdateUserAttributesCommand').map((c) => c.input)).toEqual([
      {
        UserPoolId: 'eu-north-1_FAKEPOOL',
        Username: 'thandi.nkosi',
        UserAttributes: [
          { Name: 'email', Value: CUSTOM },
          { Name: 'email_verified', Value: 'true' },
        ],
      },
    ]);
    expect(aws.users.get('thandi.nkosi')?.email).toBe(CUSTOM);

    aws.calls.length = 0;
    const repeated = await provisionSeedUsers(deps(aws))(seedUsers(withEmailA(data, CUSTOM)));
    expect(repeated.ok && repeated.value.counts.cognito_email_updated).toBe(0);
    expect(mutations(aws)).toEqual([]);

    const restored = await provisionSeedUsers(deps(aws))(users);
    expect(restored.ok && restored.value.counts.cognito_email_updated).toBe(1);
    expect(aws.users.get('thandi.nkosi')?.email).toBe('thandi.nkosi@example.com');
  });

  it('stops with only the SDK error name when the role may not update attributes, so the address is not in the error', async () => {
    const aws = fakeAws();
    await provisionSeedUsers(deps(aws))(users);
    const refusing = {
      send: async (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === 'AdminUpdateUserAttributesCommand') {
          throw Object.assign(new Error(`not authorized to update ${CUSTOM}`), { name: 'AccessDeniedException' });
        }
        return aws.cognito.send(command as never);
      },
    } as unknown as ProvisionDeps['cognito'];
    const result = await provisionSeedUsers(deps(aws, { cognito: refusing }))(seedUsers(withEmailA(data, CUSTOM)));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'provision', username: 'thandi.nkosi', step: 'AdminUpdateUserAttributes', name: 'AccessDeniedException' },
    });
    expect(JSON.stringify(result)).not.toContain(CUSTOM);
  });
});
