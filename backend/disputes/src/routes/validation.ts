import { problemBody, validationProblem, type ProblemBody } from '@cd/shared';
import type { InputError } from '@cd/dispute-domain';
import type { z } from 'zod';

// Fits a maximal valid body even with every character JSON-escaped (~40 KiB); the 1 MiB default only invites abuse.
export const DISPUTE_BODY_LIMIT_BYTES = 48 * 1024;

const INPUT_CODES: ReadonlyArray<readonly [PropertyKey, InputError]> = [
  ['reasonCode', 'INVALID_REASON'],
  ['description', 'INVALID_DESCRIPTION'],
];

const isInputField = (field: PropertyKey | undefined): boolean => INPUT_CODES.some(([f]) => f === field);

// ADR-057: when only reasonCode/description are wrong the body keeps the domain code; anything else is generic.
export const disputeBodyProblem = (error: z.ZodError, correlationId: string): ProblemBody => {
  const generic = validationProblem(error, correlationId);
  const fields = error.issues.map((i) => i.path[0]);
  const code = INPUT_CODES.find(([field]) => fields.includes(field))?.[1];
  return code !== undefined && fields.every(isInputField) ? problemBody({ ...generic, code }) : generic;
};
