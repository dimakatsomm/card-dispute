import { ok, type Result } from '@cd/shared/fp';
import { toUserCard, type UserCard } from '../core/cards.ts';
import type { CardFilter, UsersRepo } from './ports.ts';

export type ListCardsDeps = {
  readonly users: Pick<UsersRepo, 'findCards'>;
  readonly now: () => Date;
};

export const listCards =
  (deps: ListCardsDeps) =>
  async (filter: CardFilter): Promise<Result<ReadonlyArray<UserCard>, never>> => {
    const records = await deps.users.findCards(filter);
    const now = deps.now();
    return ok(records.map((record) => toUserCard(record, now)));
  };
