import type { HttpClient, ServiceTokenProvider } from '@cd/auth-client/service-client';
import { err, ok, type Result } from '@cd/shared/fp';
import type { z } from 'zod';
import type { Log, UpstreamFailure } from '../use-cases/ports.ts';

export type ServiceClientDeps = {
  readonly upstream: 'users' | 'disputes';
  readonly baseUrl: string;
  readonly http: HttpClient;
  readonly tokens: ServiceTokenProvider;
  readonly deadlineMs: number;
  readonly log: Pick<Log, 'warn'>;
};

const unavailable = err<UpstreamFailure>({ kind: 'unavailable' });

const fetchJson = async <S extends z.ZodType>(
  deps: ServiceClientDeps,
  path: string,
  schema: S,
  correlationId: string,
  signal: AbortSignal,
  mayRetry = true,
): Promise<Result<z.output<S>, UpstreamFailure>> => {
  const { upstream, log } = deps;
  const token = await deps.tokens.getToken();
  if (!token.ok) {
    log.warn({ upstream, detail: token.error.detail }, 'service token unavailable');
    return unavailable;
  }
  const res = await deps.http.request({
    url: `${deps.baseUrl}${path}`,
    headers: { authorization: `Bearer ${token.value}` },
    correlationId,
    signal,
  });
  if (mayRetry && res.ok && res.value.status === 401) {
    log.warn({ upstream }, 'upstream rejected the service token; retrying once');
    deps.tokens.invalidate(token.value);
    return fetchJson(deps, path, schema, correlationId, signal, false);
  }
  if (res.ok && res.value.status === 404) return err({ kind: 'not_found' });
  if (!res.ok || res.value.status !== 200) {
    log.warn({ upstream, status: res.ok ? res.value.status : res.error.kind }, 'upstream call failed');
    return unavailable;
  }
  const parsed = schema.safeParse(res.value.body);
  if (!parsed.success) {
    log.warn({ upstream }, 'upstream response failed validation');
    return unavailable;
  }
  return ok(parsed.data);
};

// One budget covers token + request + the http client's GET retry (ADR-054).
export const getJson =
  (deps: ServiceClientDeps) =>
  async <S extends z.ZodType>(
    path: string,
    schema: S,
    correlationId: string,
  ): Promise<Result<z.output<S>, UpstreamFailure>> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Result<z.output<S>, UpstreamFailure>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        deps.log.warn({ upstream: deps.upstream, deadlineMs: deps.deadlineMs }, 'upstream deadline exceeded');
        resolve(unavailable);
      }, deps.deadlineMs);
    });
    try {
      return await Promise.race([fetchJson(deps, path, schema, correlationId, controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
