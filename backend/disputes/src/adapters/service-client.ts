import type { AuthClient, HttpClient, ServiceTokenProvider } from '@cd/auth-client';
import { err, ok, type Result } from '@cd/shared/fp';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { UpstreamError } from '../use-cases/ports.ts';
import { withDeadline } from './deadline.ts';

export type ServiceClientDeps = {
  readonly baseUrl: string;
  readonly http: HttpClient;
  readonly tokens: ServiceTokenProvider;
  readonly log: FastifyBaseLogger;
  readonly timeoutMs: number;
};

const fetchJson = async <S extends z.ZodType>(
  deps: ServiceClientDeps,
  path: string,
  query: Readonly<Record<string, string>>,
  schema: S,
  correlationId: string,
  signal: AbortSignal,
  mayRetry = true,
): Promise<Result<z.output<S>, UpstreamError>> => {
  const token = await deps.tokens.getToken();
  if (!token.ok) {
    deps.log.warn({ detail: token.error.detail, path }, 'service token unavailable');
    return err('UPSTREAM_UNAVAILABLE');
  }
  const res = await deps.http.request({
    url: `${deps.baseUrl}${path}?${new URLSearchParams(query).toString()}`,
    headers: { authorization: `Bearer ${token.value}` },
    correlationId,
    signal,
  });
  if (mayRetry && res.ok && res.value.status === 401) {
    deps.log.warn({ path }, 'upstream rejected the service token; retrying once');
    deps.tokens.invalidate(token.value);
    return fetchJson(deps, path, query, schema, correlationId, signal, false);
  }
  if (!res.ok || res.value.status !== 200) {
    deps.log.warn({ path, status: res.ok ? res.value.status : res.error.kind }, 'upstream call failed');
    return err('UPSTREAM_UNAVAILABLE');
  }
  const parsed = schema.safeParse(res.value.body);
  if (!parsed.success) {
    deps.log.warn({ path }, 'upstream response failed validation');
    return err('UPSTREAM_UNAVAILABLE');
  }
  return ok(parsed.data);
};

// Any non-200 from our own service port is a fault on our side (bad token, scope, query), so it fails closed as 503.
// A 401 first invalidates the cached service token and retries once.
// One budget covers token + request + the http client's GET retry, which alone could take twice the per-attempt timeout.
export const getJson =
  (deps: ServiceClientDeps) =>
  <S extends z.ZodType>(
    path: string,
    query: Readonly<Record<string, string>>,
    schema: S,
    correlationId: string,
  ): Promise<Result<z.output<S>, UpstreamError>> => {
    const controller = new AbortController();
    return withDeadline(deps.timeoutMs, fetchJson(deps, path, query, schema, correlationId, controller.signal), () => {
      controller.abort();
      deps.log.warn({ path, timeoutMs: deps.timeoutMs }, 'upstream deadline exceeded');
      return err('UPSTREAM_UNAVAILABLE');
    });
  };

export const withValidateDeadline = (client: AuthClient, timeoutMs: number): AuthClient => ({
  validate: (token, correlationId) => {
    const controller = new AbortController();
    return withDeadline(timeoutMs, client.validate(token, correlationId, controller.signal), () => {
      controller.abort();
      return err({ kind: 'unavailable', detail: `no answer within ${timeoutMs}ms` });
    });
  },
});
