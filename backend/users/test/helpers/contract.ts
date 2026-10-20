import { expect } from 'vitest';
import type { z } from 'zod';

export const expectContract = <S extends z.ZodType>(schema: S, response: { json: () => unknown }): z.output<S> => {
  const parsed = schema.safeParse(response.json());
  expect(parsed.error?.issues ?? []).toEqual([]);
  return parsed.data as z.output<S>;
};
