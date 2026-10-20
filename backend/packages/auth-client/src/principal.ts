import type { zValidService, zValidUser } from '@cd/contracts/auth.service';
import type { z } from 'zod';

type ValidUser = z.output<typeof zValidUser>;
type ValidService = z.output<typeof zValidService>;

export type UserPrincipal = Readonly<Omit<ValidUser, 'valid'>>;
export type ServicePrincipal = Readonly<Omit<ValidService, 'valid'>>;
export type Principal = UserPrincipal | ServicePrincipal;

export const principalOf = (valid: ValidUser | ValidService): Principal =>
  valid.principalType === 'user'
    ? {
        principalType: valid.principalType,
        authId: valid.authId,
        userId: valid.userId,
        scopes: valid.scopes,
        exp: valid.exp,
      }
    : {
        principalType: valid.principalType,
        clientId: valid.clientId,
        scopes: valid.scopes,
        exp: valid.exp,
      };
