import { loadConfig, type Env } from '@cd/shared/lambda';
import { z } from 'zod';

export const configSchema = z.object({
  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.url({ protocol: /^https?$/ }).optional(),
  EVIDENCE_BUCKET: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = Readonly<z.output<typeof configSchema>>;

export const loadViewerConfig = (env: Env): Config => loadConfig(configSchema, env);
