import { AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { cognito, errorName, secrets } from './aws.ts';
import { env } from './env.ts';

export type Persona = 'A' | 'B' | 'D';

const USERNAMES: Readonly<Record<Persona, string>> = {
  A: 'thandi.nkosi',
  B: 'sipho.dlamini',
  D: 'dumisani.zulu',
};

const SeedSecret = z.object({ username: z.string().min(1), password: z.string().min(1) });

const seedSecret = async (persona: Persona): Promise<z.infer<typeof SeedSecret>> => {
  const out = await secrets().send(
    new GetSecretValueCommand({ SecretId: `${env().namePrefix}/dev/seed-users/${USERNAMES[persona]}` }),
  );
  const malformed = new Error(`seed secret for persona ${persona} is malformed`);
  let raw: unknown;
  try {
    raw = JSON.parse(out.SecretString ?? '');
  } catch {
    throw malformed;
  }
  const parsed = SeedSecret.safeParse(raw);
  if (!parsed.success) throw malformed;
  return parsed.data;
};

export type SignIn =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly errorName: string; readonly errorMessage: string };

export const signIn = async (persona: Persona): Promise<SignIn> => {
  const { username, password } = await seedSecret(persona);
  try {
    const out = await cognito().send(
      new AdminInitiateAuthCommand({
        UserPoolId: env().userPoolId,
        ClientId: env().e2eClientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    );
    const accessToken = out.AuthenticationResult?.AccessToken;
    return accessToken === undefined
      ? { ok: false, errorName: `Challenge:${out.ChallengeName ?? 'none'}`, errorMessage: '' }
      : { ok: true, accessToken };
  } catch (error) {
    return {
      ok: false,
      errorName: errorName(error),
      errorMessage: error instanceof Error ? error.message : '',
    };
  }
};

const TOKEN_TTL_MS = 10 * 60_000;
const cache = new Map<Persona, { readonly token: string; readonly at: number }>();

// Access tokens live 15 minutes and some suites poll for longer, so refresh early.
export const tokenFor = async (persona: Persona): Promise<string> => {
  const hit = cache.get(persona);
  if (hit !== undefined && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const result = await signIn(persona);
  if (!result.ok) throw new Error(`sign-in as ${persona} failed: ${result.errorName}`);
  cache.set(persona, { token: result.accessToken, at: Date.now() });
  return result.accessToken;
};

export const decodeClaims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
