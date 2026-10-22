import { AdminInitiateAuthCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ok, type Result } from '@cd/shared/fp';
import { parseHttpUrl, tokenError, type TokenError } from './probe.ts';
import { parseSeedUserSecret } from './seed-user-secret.ts';

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'UnknownError');

export type UserTokenDeps = {
  readonly cognito: Pick<CognitoIdentityProviderClient, 'send'>;
  readonly secrets: Pick<SecretsManagerClient, 'send'>;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly secretId: string;
};

export const userTokenVia = (deps: UserTokenDeps) => async (): Promise<Result<string, TokenError>> => {
  try {
    const stored = await deps.secrets.send(new GetSecretValueCommand({ SecretId: deps.secretId }));
    const secret = parseSeedUserSecret(stored.SecretString);
    if (secret === null) return tokenError('user', 'seed-user secret is not {username,password}');
    const out = await deps.cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: deps.userPoolId,
        ClientId: deps.clientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: secret.username, PASSWORD: secret.password },
      }),
    );
    const token = out.AuthenticationResult?.AccessToken;
    if (token === undefined) return tokenError('user', `no access token (challenge ${out.ChallengeName ?? 'none'})`);
    return ok(token);
  } catch (e) {
    return tokenError('user', errorName(e));
  }
};

export type ServiceTokenDeps = {
  readonly fetch: typeof fetch;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs: number;
};

// The client secret travels in the Authorization header, so it is only ever sent over TLS.
export const serviceTokenVia = (deps: ServiceTokenDeps) => async (): Promise<Result<string, TokenError>> => {
  if (parseHttpUrl(deps.tokenUrl, ['https:']) === null) return tokenError('service', 'TOKEN_URL must be an https URL');
  try {
    const res = await deps.fetch(deps.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.status !== 200) return tokenError('service', `token endpoint status ${res.status}`);
    const body: unknown = await res.json();
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).access_token : undefined;
    return typeof token === 'string' && token !== '' ? ok(token) : tokenError('service', 'no access_token in response');
  } catch (e) {
    return tokenError('service', errorName(e));
  }
};
