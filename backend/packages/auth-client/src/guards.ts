import { commonProblem, problemBody, sendProblem } from '@cd/shared';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthClient } from './auth-client.ts';
import type { Principal, ServicePrincipal, UserPrincipal } from './principal.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

// Scheme is case-insensitive (RFC 7235); the length cap keeps oversized tokens away from auth.
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]{1,4096}={0,2})$/i;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_MIN_LENGTH = 20;

export type GuardKind = 'user' | 'service';
export type GuardHook = onRequestAsyncHookHandler & { readonly guardKind: GuardKind };

const unauthorized = (reply: FastifyReply, request: FastifyRequest, detail: string): FastifyReply =>
  sendProblem(reply.header('www-authenticate', 'Bearer'), commonProblem('UNAUTHORIZED', detail, request.id));

const forbidden = (reply: FastifyReply, request: FastifyRequest, detail: string): FastifyReply =>
  sendProblem(reply, commonProblem('FORBIDDEN', detail, request.id));

const authUnavailable = (reply: FastifyReply, request: FastifyRequest): FastifyReply =>
  sendProblem(
    reply,
    problemBody({
      status: 503,
      title: 'Service Unavailable',
      code: 'AUTH_UNAVAILABLE',
      detail: 'Authentication is temporarily unavailable',
      correlationId: request.id,
    }),
  );

type Authorize = (principal: Principal) => string | undefined;

const guard = (kind: GuardKind, authClient: AuthClient, authorize: Authorize): GuardHook => {
  const hook: onRequestAsyncHookHandler = async (request, reply) => {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) return unauthorized(reply, request, 'Missing or malformed bearer token');
    if (token.length < JWT_MIN_LENGTH || !JWT_SHAPE.test(token)) return unauthorized(reply, request, 'Invalid token');

    const result = await authClient.validate(token, request.id);
    if (!result.ok) {
      if (result.error.kind === 'unavailable') {
        request.log.warn({ detail: result.error.detail }, 'auth validation unavailable');
        return authUnavailable(reply, request);
      }
      return unauthorized(reply, request, 'Invalid token');
    }

    const denied = authorize(result.value);
    if (denied) return forbidden(reply, request, denied);
    // Fastify carries per-request state by decorating the request.
    // eslint-disable-next-line no-param-reassign
    request.principal = result.value;
    return undefined;
  };
  return Object.assign(hook, { guardKind: kind });
};

export const requireUser = (authClient: AuthClient): GuardHook =>
  guard('user', authClient, (p) => (p.principalType === 'user' ? undefined : 'User token required'));

export const requireService = (authClient: AuthClient, scope: string): GuardHook =>
  guard('service', authClient, (p) => {
    if (p.principalType !== 'service') return 'Service token required';
    return p.scopes.includes(scope) ? undefined : 'Missing required scope';
  });

export const userPrincipalOf = (request: FastifyRequest): UserPrincipal => {
  if (request.principal?.principalType !== 'user') throw new Error('user principal missing: route is not guarded');
  return request.principal;
};

export const servicePrincipalOf = (request: FastifyRequest): ServicePrincipal => {
  if (request.principal?.principalType !== 'service') {
    throw new Error('service principal missing: route is not guarded');
  }
  return request.principal;
};
