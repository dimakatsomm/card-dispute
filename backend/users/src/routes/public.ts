import { userPrincipalOf } from '@cd/auth-client';
import { zUuid, type zGetMeResponse } from '@cd/contracts/users.public';
import { sendProblem } from '@cd/shared';
import type { RouteOptions } from 'fastify';
import type { z } from 'zod';
import type { Me } from '../core/me.ts';
import { toProblem } from '../errors.ts';
import type { UseCases } from './use-cases.ts';

type MeResponse = z.output<typeof zGetMeResponse>;

const toMeResponse = (me: Me): MeResponse => ({
  ...me,
  accounts: me.accounts.map((account) => ({ ...account, cards: [...account.cards] })),
});

export const publicRoutes = (uc: UseCases): readonly RouteOptions[] => [
  {
    method: 'GET',
    url: '/me',
    handler: async (request, reply) => {
      const userId = zUuid.safeParse(userPrincipalOf(request).userId);
      // A principal id that is not a uuid can match no profile; answering 404 avoids a pg cast error.
      if (!userId.success) return sendProblem(reply, toProblem('NOT_FOUND', request.id));
      const result = await uc.getMe(userId.data);
      return result.ok ? toMeResponse(result.value) : sendProblem(reply, toProblem(result.error, request.id));
    },
  },
];
