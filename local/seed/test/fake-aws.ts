import { randomUUID } from 'node:crypto';
import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

type FakeUser = { sub: string; enabled: boolean; status: 'FORCE_CHANGE_PASSWORD' | 'CONFIRMED'; password: string | null; email: string };
type FakeSecret = { value: string; kmsKeyId: string | undefined; tags: unknown };

export type Call = { readonly command: string; readonly input: Record<string, unknown> };

const awsError = (name: string): Error => Object.assign(new Error(name), { name });

// In-memory Cognito + Secrets Manager behind the SDK `send` boundary, recording every command it receives.
export const fakeAws = () => {
  const users = new Map<string, FakeUser>();
  const secrets = new Map<string, FakeSecret>();
  const calls: Call[] = [];
  const record = (command: { constructor: { name: string }; input: object }): void => {
    calls.push({ command: command.constructor.name, input: { ...command.input } as Record<string, unknown> });
  };
  const user = (username: string): FakeUser => {
    const u = users.get(username);
    if (u === undefined) throw awsError('UserNotFoundException');
    return u;
  };

  const cognitoSend = async (command: unknown): Promise<unknown> => {
    if (command instanceof AdminGetUserCommand) {
      record(command);
      const u = user(command.input.Username ?? '');
      return { Username: command.input.Username, Enabled: u.enabled, UserStatus: u.status, UserAttributes: [{ Name: 'sub', Value: u.sub }] };
    }
    if (command instanceof AdminCreateUserCommand) {
      record(command);
      const username = command.input.Username ?? '';
      if (users.has(username)) throw awsError('UsernameExistsException');
      const email = command.input.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '';
      users.set(username, { sub: randomUUID(), enabled: true, status: 'FORCE_CHANGE_PASSWORD', password: null, email });
      return {};
    }
    if (command instanceof AdminSetUserPasswordCommand) {
      record(command);
      const u = user(command.input.Username ?? '');
      u.password = command.input.Password ?? null;
      if (command.input.Permanent === true) u.status = 'CONFIRMED';
      return {};
    }
    if (command instanceof AdminDisableUserCommand) {
      record(command);
      user(command.input.Username ?? '').enabled = false;
      return {};
    }
    if (command instanceof AdminInitiateAuthCommand) {
      record(command);
      const u = users.get(command.input.AuthParameters?.USERNAME ?? '');
      if (u === undefined || !u.enabled || u.password !== command.input.AuthParameters?.PASSWORD) throw awsError('NotAuthorizedException');
      return { AuthenticationResult: { AccessToken: `user-token-${u.sub}` } };
    }
    throw new Error('unexpected Cognito command');
  };

  const secretsSend = async (command: unknown): Promise<unknown> => {
    const existing = (id: string | undefined): FakeSecret => {
      const s = secrets.get(id ?? '');
      if (s === undefined) throw awsError('ResourceNotFoundException');
      return s;
    };
    if (command instanceof DescribeSecretCommand) {
      record(command);
      existing(command.input.SecretId);
      return { Name: command.input.SecretId };
    }
    if (command instanceof GetSecretValueCommand) {
      record(command);
      return { SecretString: existing(command.input.SecretId).value };
    }
    if (command instanceof CreateSecretCommand) {
      record(command);
      const name = command.input.Name ?? '';
      if (secrets.has(name)) throw awsError('ResourceExistsException');
      secrets.set(name, { value: command.input.SecretString ?? '', kmsKeyId: command.input.KmsKeyId, tags: command.input.Tags });
      return {};
    }
    if (command instanceof PutSecretValueCommand) {
      record(command);
      existing(command.input.SecretId).value = command.input.SecretString ?? '';
      return {};
    }
    throw new Error('unexpected Secrets Manager command');
  };

  return {
    users,
    secrets,
    calls,
    cognito: { send: cognitoSend } as unknown as Pick<CognitoIdentityProviderClient, 'send'>,
    secretsManager: { send: secretsSend } as unknown as Pick<SecretsManagerClient, 'send'>,
    commands: (): ReadonlyArray<string> => calls.map((c) => c.command),
  };
};

export type FakeAws = ReturnType<typeof fakeAws>;

export const MUTATING = [
  'AdminCreateUserCommand',
  'AdminSetUserPasswordCommand',
  'AdminDisableUserCommand',
  'CreateSecretCommand',
  'PutSecretValueCommand',
] as const;
