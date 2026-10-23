import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { uiEnv } from './env.ts';

const PERSONA_A_USERNAME = 'thandi.nkosi';

const SeedSecret = z.object({ username: z.string().min(1), password: z.string().min(1) });

export type Credentials = z.infer<typeof SeedSecret>;

export const personaACredentials = async (): Promise<Credentials> => {
  const { region, seedSecretPrefix } = uiEnv();
  let secretString: string | undefined;
  try {
    const out = await new SecretsManagerClient({ region }).send(
      new GetSecretValueCommand({ SecretId: `${seedSecretPrefix}${PERSONA_A_USERNAME}` }),
    );
    secretString = out.SecretString;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- the cause could carry secret material into public CI logs
    throw new Error(
      `could not read the seed secret for persona A: ${error instanceof Error ? error.name : 'UnknownError'}`,
    );
  }
  const malformed = new Error('seed secret for persona A is malformed');
  let raw: unknown;
  try {
    raw = JSON.parse(secretString ?? '');
  } catch {
    throw malformed;
  }
  const parsed = SeedSecret.safeParse(raw);
  if (!parsed.success) throw malformed;
  return parsed.data;
};
