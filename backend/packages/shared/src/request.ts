import type { z } from 'zod';
import { err, ok, type Result } from './fp.ts';
import { commonProblem, type ProblemBody } from './problem.ts';

export const parseRequest = <S extends z.ZodType>(schema: S, value: unknown): Result<z.output<S>, z.ZodError> => {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
};

export const validationProblem = (error: z.ZodError, correlationId: string): ProblemBody =>
  commonProblem(
    'VALIDATION_FAILED',
    error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    correlationId,
  );
