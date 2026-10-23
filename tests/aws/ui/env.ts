import { WEB_ORIGIN_PATTERN } from '../src/env.ts';

const REQUIRED_UI_ENV = ['AWS_REGION', 'WEB_ORIGIN'] as const;

export type UiEnv = {
  readonly region: string;
  readonly webOrigin: string;
  readonly seedSecretPrefix: string;
};

export const uiEnv = (source: NodeJS.ProcessEnv = process.env): UiEnv => {
  const missing = REQUIRED_UI_ENV.filter((name) => (source[name] ?? '') === '');
  if (missing.length > 0) throw new Error(`e2e-aws-ui: unset environment variables: ${missing.join(', ')}`);
  const webOrigin = (source['WEB_ORIGIN'] ?? '').replace(/\/+$/, '');
  if (!WEB_ORIGIN_PATTERN.test(webOrigin))
    throw new Error('e2e-aws-ui: WEB_ORIGIN must match https://<id>.cloudfront.net');
  const explicit = source['SEED_USER_SECRET_PREFIX'] ?? '';
  const seedSecretPrefix = explicit !== '' ? explicit : `${source['NAME_PREFIX'] || 'cd'}/dev/seed-users/`;
  return { region: source['AWS_REGION'] ?? '', webOrigin, seedSecretPrefix };
};
