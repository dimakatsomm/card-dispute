import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { migrate } from '@cd/db';
import { bootstrap, ROLES, SERVICES, type Role } from '@cd/db/bootstrap';
import { startTestPostgres, type TestPostgres } from '@cd/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAwsSeed, type AwsSeedDeps } from '../src/aws-seed.ts';
import { DEFAULT_SEED, generateSeedData } from '../src/generate.ts';
import { generatePassword } from '../src/password.ts';
import type { UrlFor } from '../src/seed.ts';
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

const seedDeps = (aws: FakeAws): AwsSeedDeps => ({
  provision: {
    cognito: aws.cognito,
    secrets: aws.secretsManager,
    userPoolId: 'af-south-1_FAKEPOOL',
    secretPrefix: 'cd/dev/seed-users/',
    kmsKeyId: 'arn:aws:kms:af-south-1:111122223333:key/0b7c9a3e-1111-4222-8333-444455556666',
    rotatePasswords: false,
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

describe('runAwsSeed against Postgres 18 with Cognito stubbed', () => {
  const aws = fakeAws();

  it('writes auth_identity with the sub Cognito issued for each username, then a second run changes 0 rows and creates 0 users', async () => {
    const first = await runAwsSeed(seedDeps(aws))(data);
    expect(first).toMatchObject({
      ok: true,
      value: {
        cognito_user_created: 4,
        cognito_user_disabled: 1,
        seed_secret_created: 4,
        app_user: 4,
        auth_identity: 4,
        transaction: data.transactions.length,
        dispute: 4,
      },
    });
    const stored = await adminQuery('select username, cognito_sub, status from auth.auth_identity order by username');
    expect(stored.rows).toEqual(
      [...aws.users]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([username, u]) => ({ username, cognito_sub: u.sub, status: u.enabled ? 'ACTIVE' : 'DISABLED' })),
    );
    expect(stored.rows.map((r) => r.cognito_sub)).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    aws.calls.length = 0;
    const second = await runAwsSeed(seedDeps(aws))(data);
    expect(second.ok && Object.entries(second.value).filter(([, n]) => n !== 0)).toEqual([]);
    expect(aws.commands().filter((c) => (MUTATING as ReadonlyArray<string>).includes(c))).toEqual([]);
  });

  it('refuses to keep a stale auth_identity when Cognito now issues a different sub for the username', async () => {
    const recreated = fakeAws();
    const result = await runAwsSeed(seedDeps(recreated))(data);
    expect(result).toMatchObject({ ok: false, error: { kind: 'insert', schema: 'auth' } });
    expect(!result.ok && 'message' in result.error && result.error.message).toContain('thandi.nkosi');
  });
});
