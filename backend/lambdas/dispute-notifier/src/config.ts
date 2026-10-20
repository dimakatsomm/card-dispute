import { z } from 'zod';

// Compose passes unset variables as empty strings.
const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const baseUrl = z.url().transform((u) => u.replace(/\/+$/, ''));

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).catch('info');

export const configSchema = z
  .object({
    LOG_LEVEL: logLevelSchema,
    AWS_REGION: z.string().min(1),
    TOKEN_URL: z.url(),
    SERVICE_CLIENT_ID: z.string().min(1),
    SERVICE_CLIENT_SECRET: optional(z.string().min(1)),
    SERVICE_CLIENT_SECRET_ARN: optional(z.string().min(1)),
    USERS_SERVICE_URL: baseUrl,
    DISPUTES_SERVICE_URL: baseUrl,
    SES_SENDER: z.email(),
    SES_ENDPOINT: optional(z.url()),
  })
  .refine((c) => (c.SERVICE_CLIENT_SECRET === undefined) !== (c.SERVICE_CLIENT_SECRET_ARN === undefined), {
    message: 'set exactly one of SERVICE_CLIENT_SECRET (local) or SERVICE_CLIENT_SECRET_ARN',
    path: ['SERVICE_CLIENT_SECRET'],
  });

export type Config = z.output<typeof configSchema>;
