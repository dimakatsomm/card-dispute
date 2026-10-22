export const REQUIRED_ENV = [
  'AWS_REGION',
  'AWS_ACCOUNT_ID',
  'NAME_PREFIX',
  'WEB_ORIGIN',
  'COGNITO_USER_POOL_ID',
  'COGNITO_E2E_CLIENT_ID',
  'QUARANTINE_BUCKET_NAME',
  'EVIDENCE_BUCKET_NAME',
  'NOTIFICATIONS_QUEUE_URL',
  'SES_EVENTS_QUEUE_URL',
  'DEV_TOOLS_SUBNET_IDS',
  'DEV_TOOLS_SG_ID',
  'DISPUTE_NOTIFIER_SG_ID',
] as const;

export const WEB_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]+\.cloudfront\.net$/;

export type Env = {
  readonly region: string;
  readonly accountId: string;
  readonly namePrefix: string;
  readonly webOrigin: string;
  readonly userPoolId: string;
  readonly e2eClientId: string;
  readonly quarantineBucket: string;
  readonly evidenceBucket: string;
  readonly notificationsQueueUrl: string;
  readonly sesEventsQueueUrl: string;
  readonly toolsSubnetIds: readonly string[];
  readonly toolsSgId: string;
  readonly notifierSgId: string;
};

export const missingEnv = (source: NodeJS.ProcessEnv = process.env): readonly string[] =>
  REQUIRED_ENV.filter((name) => (source[name] ?? '') === '');

let cached: Env | undefined;

export const env = (): Env => {
  if (cached !== undefined) return cached;
  const missing = missingEnv();
  if (missing.length > 0) throw new Error(`e2e-aws: unset environment variables: ${missing.join(', ')}`);
  const get = (name: (typeof REQUIRED_ENV)[number]): string => process.env[name] ?? '';
  const webOrigin = get('WEB_ORIGIN').replace(/\/+$/, '');
  if (!WEB_ORIGIN_PATTERN.test(webOrigin))
    throw new Error('e2e-aws: WEB_ORIGIN must match https://<id>.cloudfront.net');
  cached = {
    region: get('AWS_REGION'),
    accountId: get('AWS_ACCOUNT_ID'),
    namePrefix: get('NAME_PREFIX'),
    webOrigin,
    userPoolId: get('COGNITO_USER_POOL_ID'),
    e2eClientId: get('COGNITO_E2E_CLIENT_ID'),
    quarantineBucket: get('QUARANTINE_BUCKET_NAME'),
    evidenceBucket: get('EVIDENCE_BUCKET_NAME'),
    notificationsQueueUrl: get('NOTIFICATIONS_QUEUE_URL'),
    sesEventsQueueUrl: get('SES_EVENTS_QUEUE_URL'),
    toolsSubnetIds: get('DEV_TOOLS_SUBNET_IDS')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
    toolsSgId: get('DEV_TOOLS_SG_ID'),
    notifierSgId: get('DISPUTE_NOTIFIER_SG_ID'),
  };
  return cached;
};
