import { userPrincipalOf } from '@cd/auth-client';
import { sendProblem } from '@cd/shared';
import type { RouteOptions } from 'fastify';
import { z } from 'zod';
import { toProblem } from '../errors.ts';
import type { UseCases } from './use-cases.ts';

const principalUserId = z.guid();

export const publicRoutes = (uc: UseCases): readonly RouteOptions[] => [
  {
    method: 'GET',
    url: '/me',
    handler: async (request, reply) => {
      const userId = principalUserId.safeParse(userPrincipalOf(request).userId);
      // A principal id that is not a uuid can match no profile; answering 404 avoids a pg cast error.
      if (!userId.success) return sendProblem(reply, toProblem('NOT_FOUND', request.id));
      const result = await uc.getMe(userId.data);
      return result.ok ? result.value : sendProblem(reply, toProblem(result.error, request.id));
    },
  },
];
