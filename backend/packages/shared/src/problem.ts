import type { FastifyReply } from 'fastify';

export const PROBLEMS = {
  BAD_REQUEST: { status: 400, title: 'Bad Request' },
  VALIDATION_FAILED: { status: 400, title: 'Validation Failed' },
  UNAUTHORIZED: { status: 401, title: 'Unauthorized' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  NOT_FOUND: { status: 404, title: 'Not Found' },
  INTERNAL_ERROR: { status: 500, title: 'Internal Server Error' },
  NOT_READY: { status: 503, title: 'Service Unavailable' },
} as const;

export type ProblemBody = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly correlationId: string;
};

export type ProblemInput = Omit<ProblemBody, 'type'>;

export const problemBody = (input: ProblemInput): ProblemBody => ({
  type: `urn:cd:problem:${input.code}`,
  title: input.title,
  status: input.status,
  detail: input.detail,
  code: input.code,
  correlationId: input.correlationId,
});

export const commonProblem = (
  code: keyof typeof PROBLEMS,
  detail: string,
  correlationId: string,
): ProblemBody => problemBody({ ...PROBLEMS[code], code, detail, correlationId });

export const sendProblem = (reply: FastifyReply, body: ProblemBody): FastifyReply =>
  reply.code(body.status).type('application/problem+json').send(body);
