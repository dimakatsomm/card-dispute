import { z } from 'zod';

const scopes = z.array(z.string());

const userShape = {
  principalType: z.literal('user'),
  authId: z.string().min(1),
  userId: z.string().min(1),
  scopes,
  exp: z.number().int(),
};

const serviceShape = {
  principalType: z.literal('service'),
  clientId: z.string().min(1),
  scopes,
  exp: z.number().int(),
};

export const userPrincipalSchema = z.object(userShape);
export const servicePrincipalSchema = z.object(serviceShape);

export type UserPrincipal = Readonly<z.output<typeof userPrincipalSchema>>;
export type ServicePrincipal = Readonly<z.output<typeof servicePrincipalSchema>>;
export type Principal = UserPrincipal | ServicePrincipal;

const validUser = z.object({ valid: z.literal(true), ...userShape }).transform((d) => ({
  valid: true as const,
  principal: {
    principalType: d.principalType,
    authId: d.authId,
    userId: d.userId,
    scopes: d.scopes,
    exp: d.exp,
  },
}));

const validService = z.object({ valid: z.literal(true), ...serviceShape }).transform((d) => ({
  valid: true as const,
  principal: {
    principalType: d.principalType,
    clientId: d.clientId,
    scopes: d.scopes,
    exp: d.exp,
  },
}));

export const validateResponseSchema = z.union([
  validUser,
  validService,
  z.object({ valid: z.literal(false), reason: z.string() }),
]);
