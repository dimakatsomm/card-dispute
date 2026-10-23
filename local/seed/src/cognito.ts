import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { err, ok, type Result } from '@cd/shared/fp';
import { encodeSeedUserSecret, parseSeedUserSecret } from './seed-user-secret.ts';

export type SeedUser = { readonly username: string; readonly email: string; readonly disabled: boolean };

export type ProvisionDeps = {
  readonly cognito: Pick<CognitoIdentityProviderClient, 'send'>;
  readonly secrets: Pick<SecretsManagerClient, 'send'>;
  readonly userPoolId: string;
  readonly secretPrefix: string;
  readonly kmsKeyId: string;
  readonly rotatePasswords: boolean;
  readonly newPassword: () => string;
};

export type ProvisionCounts = {
  readonly cognito_user_created: number;
  readonly cognito_user_disabled: number;
  readonly cognito_email_updated: number;
  readonly cognito_password_set: number;
  readonly seed_secret_created: number;
  readonly seed_secret_updated: number;
};

export type Provisioned = { readonly subs: ReadonlyMap<string, string>; readonly counts: ProvisionCounts };

export type ProvisionError = {
  readonly kind: 'provision';
  readonly username: string;
  readonly step: string;
  readonly name: string;
  readonly action?: string;
};

export const ROTATE_ACTION = 'Cognito holds a password the secret does not; re-run dev-seed with SEED_ROTATE_USER_PASSWORDS=true';

type CognitoUser = { readonly sub: string; readonly email: string | undefined; readonly enabled: boolean; readonly confirmed: boolean };
type Step<T> = Promise<Result<T, ProvisionError>>;

const ZERO: ProvisionCounts = {
  cognito_user_created: 0,
  cognito_user_disabled: 0,
  cognito_email_updated: 0,
  cognito_password_set: 0,
  seed_secret_created: 0,
  seed_secret_updated: 0,
};

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'UnknownError');

// Only the SDK error name is kept, so no message text can reach the logs.
const attempt = async <T>(username: string, step: string, fn: () => Promise<T>): Step<T> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err({ kind: 'provision', username, step, name: errorName(e) });
  }
};

const isNotFound = (e: unknown, name: string): boolean => e instanceof Error && e.name === name;

const getUser = (deps: ProvisionDeps, username: string): Step<CognitoUser | null> =>
  attempt(username, 'AdminGetUser', async () => {
    try {
      const out = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: username }));
      const attribute = (name: string): string | undefined => out.UserAttributes?.find((a) => a.Name === name)?.Value;
      const sub = attribute('sub');
      if (sub === undefined || sub === '') throw Object.assign(new Error('missing sub'), { name: 'MissingSub' });
      return { sub, email: attribute('email'), enabled: out.Enabled !== false, confirmed: out.UserStatus === 'CONFIRMED' };
    } catch (e) {
      if (isNotFound(e, 'UserNotFoundException')) return null;
      throw e;
    }
  });

const createUser = (deps: ProvisionDeps, user: SeedUser): Step<unknown> =>
  attempt(user.username, 'AdminCreateUser', () =>
    deps.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: deps.userPoolId,
        Username: user.username,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: user.email },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    ),
  );

const setPassword = (deps: ProvisionDeps, username: string, password: string): Step<unknown> =>
  attempt(username, 'AdminSetUserPassword', () =>
    deps.cognito.send(
      new AdminSetUserPasswordCommand({ UserPoolId: deps.userPoolId, Username: username, Password: password, Permanent: true }),
    ),
  );

const updateEmail = (deps: ProvisionDeps, user: SeedUser): Step<unknown> =>
  attempt(user.username, 'AdminUpdateUserAttributes', () =>
    deps.cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: deps.userPoolId,
        Username: user.username,
        UserAttributes: [
          { Name: 'email', Value: user.email },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    ),
  );

const disableUser = (deps: ProvisionDeps, username: string): Step<unknown> =>
  attempt(username, 'AdminDisableUser', () =>
    deps.cognito.send(new AdminDisableUserCommand({ UserPoolId: deps.userPoolId, Username: username })),
  );

const secretExists = (deps: ProvisionDeps, username: string, name: string): Step<boolean> =>
  attempt(username, 'DescribeSecret', async () => {
    try {
      await deps.secrets.send(new DescribeSecretCommand({ SecretId: name }));
      return true;
    } catch (e) {
      if (isNotFound(e, 'ResourceNotFoundException')) return false;
      throw e;
    }
  });

const storedPassword = (deps: ProvisionDeps, username: string, name: string): Step<string | null> =>
  attempt(username, 'GetSecretValue', async () => {
    const out = await deps.secrets.send(new GetSecretValueCommand({ SecretId: name }));
    return parseSeedUserSecret(out.SecretString)?.password ?? null;
  });

// KmsKeyId must equal the cd-data ARN exactly and Tags stay unset: the dev-seed IAM condition allows nothing else.
const createSecret = (deps: ProvisionDeps, username: string, name: string, password: string): Step<unknown> =>
  attempt(username, 'CreateSecret', () =>
    deps.secrets.send(
      new CreateSecretCommand({
        Name: name,
        KmsKeyId: deps.kmsKeyId,
        SecretString: encodeSeedUserSecret({ username, password }),
      }),
    ),
  );

const putSecret = (deps: ProvisionDeps, username: string, name: string, password: string): Step<unknown> =>
  attempt(username, 'PutSecretValue', () =>
    deps.secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: encodeSeedUserSecret({ username, password }) })),
  );

type PasswordPlan =
  | { readonly kind: 'keep' }
  | { readonly kind: 'set'; readonly password: string; readonly secret: 'create' | 'put' | 'keep' };

// The secret is written after the password is set, so a failed run leaves no secret that Cognito does not accept.
const planPassword = async (
  deps: ProvisionDeps,
  user: SeedUser,
  secretName: string,
  needsPassword: boolean,
): Step<PasswordPlan> => {
  const exists = await secretExists(deps, user.username, secretName);
  if (!exists.ok) return exists;
  if (!exists.value) return ok({ kind: 'set', password: deps.newPassword(), secret: 'create' });
  if (deps.rotatePasswords) return ok({ kind: 'set', password: deps.newPassword(), secret: 'put' });
  if (!needsPassword) return ok({ kind: 'keep' });
  const stored = await storedPassword(deps, user.username, secretName);
  if (!stored.ok) return stored;
  return ok(
    stored.value === null
      ? { kind: 'set', password: deps.newPassword(), secret: 'put' }
      : { kind: 'set', password: stored.value, secret: 'keep' },
  );
};

const applyPassword = async (
  deps: ProvisionDeps,
  username: string,
  secretName: string,
  plan: PasswordPlan,
): Step<Partial<ProvisionCounts>> => {
  if (plan.kind === 'keep') return ok({});
  const set = await setPassword(deps, username, plan.password);
  if (!set.ok) return set;
  if (plan.secret === 'keep') return ok({ cognito_password_set: 1 });
  const write =
    plan.secret === 'create'
      ? await createSecret(deps, username, secretName, plan.password)
      : await putSecret(deps, username, secretName, plan.password);
  // A failed CreateSecret heals on the next run (secret missing); a failed Put would otherwise be kept forever.
  if (!write.ok && plan.secret === 'put') {
    return err({ ...write.error, step: 'PutSecretValueAfterPasswordSet', action: ROTATE_ACTION });
  }
  if (!write.ok) return write;
  return ok({ cognito_password_set: 1, [plan.secret === 'create' ? 'seed_secret_created' : 'seed_secret_updated']: 1 });
};

const provisionOne = async (
  deps: ProvisionDeps,
  user: SeedUser,
): Step<{ readonly sub: string; readonly counts: Partial<ProvisionCounts> }> => {
  const found = await getUser(deps, user.username);
  if (!found.ok) return found;
  const created = found.value === null;
  if (created) {
    const made = await createUser(deps, user);
    if (!made.ok) return made;
  }
  // The sub is read back from AdminGetUser so auth_identity always maps the identity Cognito actually issued.
  const current = created ? await getUser(deps, user.username) : found;
  if (!current.ok) return current;
  if (current.value === null) return err({ kind: 'provision', username: user.username, step: 'AdminGetUser', name: 'UserNotFoundException' });
  const cognitoUser = current.value;

  const mustUpdateEmail = cognitoUser.email !== user.email;
  if (mustUpdateEmail) {
    const updated = await updateEmail(deps, user);
    if (!updated.ok) return updated;
  }

  const secretName = `${deps.secretPrefix}${user.username}`;
  const plan = await planPassword(deps, user, secretName, created || !cognitoUser.confirmed);
  if (!plan.ok) return plan;
  const applied = await applyPassword(deps, user.username, secretName, plan.value);
  if (!applied.ok) return applied;

  const mustDisable = user.disabled && cognitoUser.enabled;
  if (mustDisable) {
    const disabled = await disableUser(deps, user.username);
    if (!disabled.ok) return disabled;
  }
  return ok({
    sub: cognitoUser.sub,
    counts: {
      ...applied.value,
      cognito_user_created: created ? 1 : 0,
      cognito_user_disabled: mustDisable ? 1 : 0,
      cognito_email_updated: mustUpdateEmail ? 1 : 0,
    },
  });
};

const addCounts = (a: ProvisionCounts, b: Partial<ProvisionCounts>): ProvisionCounts => ({
  cognito_user_created: a.cognito_user_created + (b.cognito_user_created ?? 0),
  cognito_user_disabled: a.cognito_user_disabled + (b.cognito_user_disabled ?? 0),
  cognito_email_updated: a.cognito_email_updated + (b.cognito_email_updated ?? 0),
  cognito_password_set: a.cognito_password_set + (b.cognito_password_set ?? 0),
  seed_secret_created: a.seed_secret_created + (b.seed_secret_created ?? 0),
  seed_secret_updated: a.seed_secret_updated + (b.seed_secret_updated ?? 0),
});

export const provisionSeedUsers =
  (deps: ProvisionDeps) =>
  async (users: ReadonlyArray<SeedUser>): Promise<Result<Provisioned, ProvisionError>> => {
    const subs = new Map<string, string>();
    let counts = ZERO;
    for (const user of users) {
      const result = await provisionOne(deps, user);
      if (!result.ok) return result;
      subs.set(user.username, result.value.sub);
      counts = addCounts(counts, result.value.counts);
    }
    return ok({ subs, counts });
  };
