import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@cd/shared/fp';
import { createHttpClient, type Fetch } from './http-client.ts';
import { validateResponseSchema, type Principal } from './principal.ts';
import type { TokenError } from './service-token.ts';

export type AuthFailure =
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type AuthClientDeps = {
  readonly authUrl: string;
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly getServiceToken: () => Promise<Result<string, TokenError>>;
  readonly cacheMaxSeconds?: number;
};

export type AuthClient = {
  readonly validate: (token: string, correlationId?: string) => Promise<Result<Principal, AuthFailure>>;
};

const MAX_CACHE_ENTRIES = 10_000;

type CacheEntry = { readonly principal: Principal; readonly expiresAt: number };

const unavailable = (detail: string) => err<AuthFailure>({ kind: 'unavailable', detail });

export const createAuthClient = (deps: AuthClientDeps): AuthClient => {
  const http = createHttpClient({ fetch: deps.fetch });
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

  const lookup = async (
    key: string,
    token: string,
    correlationId: string | undefined,
  ): Promise<Result<Principal, AuthFailure>> => {
    const serviceToken = await deps.getServiceToken();
    if (!serviceToken.ok) return unavailable(serviceToken.error.detail);

    const res = await http.request({
      url: `${deps.authUrl}/validate`,
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    if (!res.ok) return unavailable(res.error.detail);
    if (res.value.status !== 200) return unavailable(`auth responded ${res.value.status}`);

    const parsed = validateResponseSchema.safeParse(res.value.body);
    if (!parsed.success) return unavailable('unparseable auth response');
    if (!parsed.data.valid) return err({ kind: 'invalid', reason: parsed.data.reason });

    remember(key, parsed.data.principal);
    return ok(parsed.data.principal);
  };

  return {
    validate: async (token, correlationId) => {
      const key = createHash('sha256').update(token).digest('hex');
      const hit = cache.get(key);
      if (hit && deps.now() < hit.expiresAt) return ok(hit.principal);
      cache.delete(key);

      const pending =
        inflight.get(key) ??
        lookup(key, token, correlationId).finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, pending);
      return pending;
    },
  };
};
