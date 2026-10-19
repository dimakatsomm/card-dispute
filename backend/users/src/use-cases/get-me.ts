import { err, ok, type Result } from '@cd/shared/fp';
import { assembleMe, type Me } from '../core/me.ts';
import type { UsersRepo } from './ports.ts';

export type GetMeDeps = {
  readonly users: Pick<UsersRepo, 'findMe'>;
  readonly now: () => Date;
};

export type GetMeError = 'NOT_FOUND';

export const getMe =
  (deps: GetMeDeps) =>
  async (userId: string): Promise<Result<Me, GetMeError>> => {
    const record = await deps.users.findMe(userId);
    return record === null ? err('NOT_FOUND') : ok(assembleMe(record, deps.now()));
  };
