import { err, ok } from '@cd/shared/fp';
import type { SecretResolver } from '@cd/shared/lambda';
import { describe, expect, it } from 'vitest';
import { resolveDbTarget } from '../src/adapters/connection.ts';
import { loadSweeperConfig } from '../src/config.ts';

const PASSWORD = 'fake-rds-password-0001';
const RDS_SECRET = JSON.stringify({
  engine: 'postgres',
  username: 'disputes_retention',
  password: PASSWORD,
  host: 'db.local',
  port: 5432,
  dbname: 'cd',
});

const resolverReturning =
  (result: Awaited<ReturnType<SecretResolver>>): SecretResolver =>
  () =>
    Promise.resolve(result);

describe('resolveDbTarget', () => {
  it.each<[string, Awaited<ReturnType<SecretResolver>>, unknown]>([
    [
      'an RDS secret becomes discrete connection fields',
      ok(RDS_SECRET),
      ok({ host: 'db.local', port: 5432, database: 'cd', user: 'disputes_retention', password: PASSWORD }),
    ],
    ['a missing secret', err({ kind: 'not_found', secretId: 'x' }), err({ kind: 'secret_unavailable', reason: 'not_found' })],
    ['a secret that is not JSON', ok(`postgres://u:${PASSWORD}@h/cd`), err({ kind: 'secret_malformed' })],
    ['a secret without a password', ok(JSON.stringify({ username: 'u', host: 'h', dbname: 'cd' })), err({ kind: 'secret_malformed' })],
  ])('%s', async (_name, secret, expected) => {
    expect(await resolveDbTarget({ DATABASE_SECRET_ID: 'cd/dev/db/disputes_retention' }, resolverReturning(secret))).toEqual(
      expected,
    );
  });

  it('uses DATABASE_URL locally without calling Secrets Manager', async () => {
    const resolver: SecretResolver = () => Promise.reject(new Error('must not be called'));
    expect(await resolveDbTarget({ DATABASE_URL: 'postgres://local/cd' }, resolver)).toEqual(
      ok({ connectionString: 'postgres://local/cd' }),
    );
  });
});

describe('loadSweeperConfig', () => {
  it.each<[string, Record<string, string>]>([
    ['neither', {}],
    ['both', { DATABASE_URL: `postgres://u:${PASSWORD}@h/cd`, DATABASE_SECRET_ID: 's' }],
  ])('rejects %s of DATABASE_URL and DATABASE_SECRET_ID without echoing values', (_name, env) => {
    expect(() => loadSweeperConfig(env)).toThrow(/exactly one of DATABASE_URL or DATABASE_SECRET_ID/);
    expect(() => loadSweeperConfig(env)).not.toThrow(new RegExp(PASSWORD));
  });

  it('rejects DATABASE_SECRET_ID without DB_SSL=true, so plaintext is possible only with a local DATABASE_URL', () => {
    expect(() => loadSweeperConfig({ DATABASE_SECRET_ID: 's' })).toThrow(/DB_SSL must be true/);
    expect(() => loadSweeperConfig({ DATABASE_SECRET_ID: 's', DB_SSL: 'false' })).toThrow(/DB_SSL must be true/);
    expect(loadSweeperConfig({ DATABASE_URL: 'postgres://local/cd' })).toMatchObject({ DB_SSL: false });
  });

  it('reads the batch cap and SSL flag from env', () => {
    expect(loadSweeperConfig({ DATABASE_SECRET_ID: 's', SWEEP_BATCH_SIZE: '25', DB_SSL: 'true' })).toMatchObject({
      SWEEP_BATCH_SIZE: 25,
      DB_SSL: true,
    });
  });
});
