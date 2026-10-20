import { GetSecretValueCommand, type GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';
import { err, ok, type Result } from './fp.ts';

export type SecretsClient = {
  readonly send: (command: GetSecretValueCommand) => Promise<GetSecretValueCommandOutput>;
};

export type SecretError = {
  readonly kind: 'not_found' | 'unavailable';
  readonly secretId: string;
};

export type SecretResolver = (secretId: string) => Promise<Result<string, SecretError>>;

export const createSecretResolver =
  (client: SecretsClient): SecretResolver =>
  async (secretId) => {
    try {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      return out.SecretString ? ok(out.SecretString) : err({ kind: 'not_found', secretId });
    } catch (error) {
      const name = error instanceof Error ? error.name : undefined;
      return err({ kind: name === 'ResourceNotFoundException' ? 'not_found' : 'unavailable', secretId });
    }
  };
