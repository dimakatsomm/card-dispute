import type { getContact } from '../use-cases/get-contact.ts';
import type { getMe } from '../use-cases/get-me.ts';
import type { listCards } from '../use-cases/list-cards.ts';

export type UseCases = {
  readonly getMe: ReturnType<typeof getMe>;
  readonly listCards: ReturnType<typeof listCards>;
  readonly getContact: ReturnType<typeof getContact>;
};
