import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item.length > 0)
      : undefined,
  );

const schema = z.object({
  AWS_ENDPOINT_URL: z.string().min(1),
  AWS_REGION: z.string().min(1),
  QUARANTINE_BUCKET: z.string().min(1).default('cd-evidence-quarantine'),
  INTAKE_URL: z.string().min(1),
  INTAKE_DLQ_NAME: z.string().min(1).default('evidence-intake-dlq'),
  INTAKE_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  NOTIFICATIONS_QUEUE_NAME: z.string().min(1).default('dispute-notifications'),
  NOTIFIER_URL: z.string().min(1),
  SWEEPER_URL: z.string().min(1),
  INVOKE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SES_PORT: z.coerce.number().int().positive().default(55901),
  SES_VERIFIED: csv,
});

export type Config = Readonly<z.infer<typeof schema>>;

export const loadConfig = (env: NodeJS.ProcessEnv): Config =>
  schema.parse({ ...env, AWS_REGION: env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'] });
