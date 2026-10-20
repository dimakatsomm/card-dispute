import { parseRequest, sendProblem, validationProblem, type RegisterRoutes } from '@cd/shared';
import type { Result } from '@cd/shared/fp';
import { z } from 'zod';
import type { CallerError, ServiceCaller } from '../core/caller.ts';
import type { InvalidReason, Principal } from '../core/token.ts';
import { callerProblem, validateResponse } from '../errors.ts';

export type ServiceRouteUseCases = {
  readonly authenticateCaller: (input: {
    readonly authorization: string | undefined;
  }) => Promise<Result<ServiceCaller, CallerError>>;
  readonly validateToken: (token: string) => Promise<Result<Principal, InvalidReason>>;
};

const validateBody = z.strictObject({ token: z.string().min(20).max(8192) });

export const serviceRoutes =
  (uc: ServiceRouteUseCases): RegisterRoutes =>
  (app) => {
    app.post(
      '/validate',
      {
        bodyLimit: 16_384,
        // onRequest runs before body parsing, so an unauthenticated caller learns nothing about the body rules.
        onRequest: async (request, reply) => {
          const caller = await uc.authenticateCaller({ authorization: request.headers.authorization });
          if (caller.ok) return undefined;
          const problem = callerProblem(caller.error, request.id);
          if (problem.status === 401) reply.header('www-authenticate', 'Bearer');
          return sendProblem(reply, problem);
        },
      },
      async (request, reply) => {
        const body = parseRequest(validateBody, request.body);
        if (!body.ok) return sendProblem(reply, validationProblem(body.error, request.id));
        return validateResponse(await uc.validateToken(body.value.token));
      },
    );
  };
