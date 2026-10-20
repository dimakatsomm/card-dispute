import { createHash } from 'node:crypto';
import { zValidateTokenResponse } from '@cd/contracts/auth.service';
import { err, ok, type Result } from '@cd/shared/fp';
import { createHttpClient, type Fetch, type HttpResponse } from './http-client.ts';
import { principalOf, type Principal } from './principal.ts';
import type { TokenError } from './service-token.ts';

export type AuthFailure =
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type AuthClientDeps = {
  readonly authUrl: string;
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly getServiceToken: () => Promise<Result<string, TokenError>>;
  readonly invalidateServiceToken?: (rejectedToken: string) => void;
  readonly timeoutMs?: number;
  readonly cacheMaxSeconds?: number;
};

export type AuthClient = {
  readonly validate: (
    token: string,
    correlationId?: string,
    signal?: AbortSignal,
  ) => Promise<Result<Principal, AuthFailure>>;
};

const MAX_CACHE_ENTRIES = 10_000;

type CacheEntry = { readonly principal: Principal; readonly expiresAt: number };

const unavailable = (detail: string) => err<AuthFailure>({ kind: 'unavailable', detail });

export const createAuthClient = (deps: AuthClientDeps): AuthClient => {
  const http = createHttpClient({ fetch: deps.fetch });
  const timeoutMs = deps.timeoutMs ?? 2000;
  const cacheMaxMs = (deps.cacheMaxSeconds ?? 60) * 1000;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Result<Principal, AuthFailure>>>();

  const remember = (key: string, principal: Principal): void => {
    const now = deps.now();
    const expiresAt = Math.min(principal.exp * 1000, now + cacheMaxMs);
    if (expiresAt <= now) return;
    if (cache.size >= MAX_CACHE_ENTRIES) {
      for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
      const oldest = cache.keys().next();
      if (cache.size >= MAX_CACHE_ENTRIES && !oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { principal, expiresAt });
  };

  const callValidate = async (
    token: string,
    correlationId: string | undefined,
    signal: AbortSignal,
    mayRetry: boolean,
  ): Promise<Result<HttpResponse, AuthFailure>> => {
    const serviceToken = await deps.getServiceToken();
    if (!serviceToken.ok) return unavailable(serviceToken.error.detail);

    const res = await http.request({
      url: `${deps.authUrl}/validate`,
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal,
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    if (!res.ok) return unavailable(res.error.detail);
    if (res.value.status !== 401) return ok(res.value);
    // Our own service token was rejected (key rotation, revocation): refetch once, then give up.
    if (!mayRetry || signal.aborted || !deps.invalidateServiceToken) return unavailable('auth rejected the service token');
    deps.invalidateServiceToken(serviceToken.value);
    return callValidate(token, correlationId, signal, false);
  };

  const lookup = async (
    key: string,
    token: string,
    correlationId: string | undefined,
    signal: AbortSignal,
  ): Promise<Result<Principal, AuthFailure>> => {
    const res = await callValidate(token, correlationId, signal, true);
    if (!res.ok) return res;
    if (res.value.status === 400) return err({ kind: 'invalid', reason: 'malformed' });
    if (res.value.status !== 200) return unavailable(`auth responded ${res.value.status}`);

    const parsed = zValidateTokenResponse.safeParse(res.value.body);
    if (!parsed.success) return unavailable('unparseable auth response');
    if (parsed.data.principalType === 'none') return err({ kind: 'invalid', reason: parsed.data.reason });

    const principal = principalOf(parsed.data);
    remember(key, principal);
    return ok(principal);
  };

  // The shared lookup has its own deadline so one joiner's signal can never abort it for the others.
  const boundedLookup = async (
    key: string,
    token: string,
    correlationId: string | undefined,
  ): Promise<Result<Principal, AuthFailure>> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Result<Principal, AuthFailure>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(unavailable(`no answer within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([lookup(key, token, correlationId, controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  const abandonOn = (
    pending: Promise<Result<Principal, AuthFailure>>,
    signal: AbortSignal | undefined,
  ): Promise<Result<Principal, AuthFailure>> =>
    signal === undefined
      ? pending
      : new Promise((resolve) => {
          const onAbort = (): void => {
            resolve(unavailable('caller gave up'));
          };
          if (signal.aborted) onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          void pending.then(resolve).finally(() => {
            signal.removeEventListener('abort', onAbort);
          });
        });

  return {
    validate: async (token, correlationId, signal) => {
      const key = createHash('sha256').update(token).digest('hex');
      const hit = cache.get(key);
      if (hit && deps.now() < hit.expiresAt) return ok(hit.principal);
      cache.delete(key);

      const pending =
        inflight.get(key) ??
        boundedLookup(key, token, correlationId).finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, pending);
      return abandonOn(pending, signal);
    },
  };
};
