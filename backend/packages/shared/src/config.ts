import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export const serverConfigSchema = z.object({
  PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

// Messages name keys and reasons only, never values: env holds secrets.
export const loadConfig = <S extends z.ZodType>(schema: S, env: Env = process.env): z.output<S> => {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(`Invalid configuration: ${problems.join('; ')}`);
};
