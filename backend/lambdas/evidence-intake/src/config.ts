import { z } from 'zod';

const flag = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

export const configSchema = z
  .object({
    AWS_REGION: z.string().min(1),
    AWS_ENDPOINT_URL: z.url().optional(),
    QUARANTINE_BUCKET: z.string().min(1),
    EVIDENCE_BUCKET: z.string().min(1),
    DISPUTES_SERVICE_URL: z.url(),
    TOKEN_URL: z.url(),
    SERVICE_CLIENT_ID: z.string().min(1),
    SERVICE_CLIENT_SECRET: z.string().min(1).optional(),
    SERVICE_CLIENT_SECRET_ID: z.string().min(1).optional(),
    EVIDENCE_REQUIRE_SCAN: flag,
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .refine((c) => (c.SERVICE_CLIENT_SECRET === undefined) !== (c.SERVICE_CLIENT_SECRET_ID === undefined), {
    message: 'set exactly one of SERVICE_CLIENT_SECRET (local) or SERVICE_CLIENT_SECRET_ID (Secrets Manager)',
    path: ['SERVICE_CLIENT_SECRET_ID'],
  });

export type Config = Readonly<z.output<typeof configSchema>>;
