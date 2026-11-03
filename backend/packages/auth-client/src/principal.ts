import type { zValidAgent, zValidService, zValidUser } from '@cd/contracts/auth.service';
import type { z } from 'zod';

type ValidUser = z.output<typeof zValidUser>;
type ValidService = z.output<typeof zValidService>;
type ValidAgent = z.output<typeof zValidAgent>;

export type UserPrincipal = Readonly<Omit<ValidUser, 'valid'>>;
export type ServicePrincipal = Readonly<Omit<ValidService, 'valid'>>;
export type AgentPrincipal = Readonly<Omit<ValidAgent, 'valid'>>;
export type Principal = UserPrincipal | ServicePrincipal | AgentPrincipal;

export const principalOf = (valid: ValidUser | ValidService | ValidAgent): Principal => {
  switch (valid.principalType) {
    case 'user':
      return {
        principalType: valid.principalType,
        authId: valid.authId,
        userId: valid.userId,
        scopes: valid.scopes,
        exp: valid.exp,
      };
    case 'service':
      return {
        principalType: valid.principalType,
        clientId: valid.clientId,
        scopes: valid.scopes,
        exp: valid.exp,
      };
    case 'agent':
      return {
        principalType: valid.principalType,
        agentId: valid.agentId,
        scopes: valid.scopes,
        exp: valid.exp,
      };
  }
};
