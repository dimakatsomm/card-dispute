import type { SecretResolver } from '@cd/shared/lambda';

export type ClientSecretSource =
  | { readonly kind: 'env'; readonly value: string }
  | { readonly kind: 'secrets-manager'; readonly secretId: string };

export const clientSecretSource = (config: {
  readonly SERVICE_CLIENT_SECRET?: string | undefined;
  readonly SERVICE_CLIENT_SECRET_ID?: string | undefined;
}): ClientSecretSource =>
  config.SERVICE_CLIENT_SECRET_ID
    ? { kind: 'secrets-manager', secretId: config.SERVICE_CLIENT_SECRET_ID }
    : { kind: 'env', value: config.SERVICE_CLIENT_SECRET ?? '' };

// Thrown during init: without its secret the function cannot call disputes, and the async retry then the DLQ keep the event.
export const resolveClientSecret = async (
  source: ClientSecretSource,
  resolve: () => SecretResolver,
): Promise<string> => {
  if (source.kind === 'env') return source.value;
  const secret = await resolve()(source.secretId);
  if (!secret.ok) throw new Error(`service client secret ${secret.error.kind}`);
  const value = secret.value.trim();
  if (!value) throw new Error('service client secret empty');
  return value;
};
