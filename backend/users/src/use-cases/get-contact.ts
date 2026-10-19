import { err, ok, type Result } from '@cd/shared/fp';
import type { Contact, UsersRepo } from './ports.ts';

export type GetContactDeps = { readonly users: Pick<UsersRepo, 'findContact'> };

export type GetContactError = 'NOT_FOUND';

export const getContact =
  (deps: GetContactDeps) =>
  async (userId: string): Promise<Result<Contact, GetContactError>> => {
    const contact = await deps.users.findContact(userId);
    return contact === null ? err('NOT_FOUND') : ok(contact);
  };
