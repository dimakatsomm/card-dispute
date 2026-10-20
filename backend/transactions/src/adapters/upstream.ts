import type { HttpClient, TokenError } from '@cd/auth-client';
import { zLookupDisputesResponse } from '@cd/contracts/disputes.service';
import { zListCardsForUserResponse } from '@cd/contracts/users.service';
import { err, ok, type Result } from '@cd/shared/fp';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { CardRef, DisputeRef, UpstreamError } from '../core/disputable.ts';

export type UpstreamDeps = {
  readonly http: HttpClient;
  readonly getToken: () => Promise<Result<string, TokenError>>;
  readonly invalidateToken: (rejectedToken: string) => void;
  readonly log: FastifyBaseLogger;
  readonly baseUrl: string;
  readonly timeoutMs: number;
};

// One budget for token + request + the http client's GET retry, so a slow upstream never holds the page past it.
const withDeadline = async <T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<Result<T, string>>,
): Promise<Result<T, string>> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Result<T, string>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(err(`no answer within ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const getJson = async <S extends z.ZodType>(
  deps: UpstreamDeps,
  path: string,
  schema: S,
  correlationId: string,
  signal: AbortSignal,
  mayRetry = true,
): Promise<Result<z.output<S>, string>> => {
  const token = await deps.getToken();
  if (!token.ok) return err(token.error.detail);
  const res = await deps.http.request({
    url: `${deps.baseUrl}${path}`,
    headers: { authorization: `Bearer ${token.value}` },
    correlationId,
    signal,
  });
  if (mayRetry && res.ok && res.value.status === 401) {
    deps.log.warn({ path }, 'upstream rejected the service token; retrying once');
    deps.invalidateToken(token.value);
    return getJson(deps, path, schema, correlationId, signal, false);
  }
  if (!res.ok) return err(res.error.detail);
  if (res.value.status !== 200) return err(`responded ${res.value.status}`);
  const parsed = schema.safeParse(res.value.body);
  return parsed.success ? ok(parsed.data) : err('unparseable response');
};

const call = async <S extends z.ZodType>(
  service: UpstreamError['service'],
  deps: UpstreamDeps,
  path: string,
  schema: S,
  correlationId: string,
): Promise<Result<z.output<S>, UpstreamError>> => {
  const result = await withDeadline(deps.timeoutMs, (signal) => getJson(deps, path, schema, correlationId, signal));
  return result.ok ? result : err({ service, detail: result.error });
};

type CachedCards = { readonly cards: ReadonlyArray<CardRef>; readonly expiresAt: number };

const MAX_CACHED_USERS = 10_000;

export type UsersClientDeps = UpstreamDeps & { readonly cacheTtlMs: number; readonly nowMs: () => number };

export const createUsersClient = (deps: UsersClientDeps) => {
  const cache = new Map<string, CachedCards>();

  const remember = (userId: string, cards: ReadonlyArray<CardRef>): void => {
    const now = deps.nowMs();
    if (cache.size >= MAX_CACHED_USERS) {
      for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
      const oldest = cache.keys().next();
      if (cache.size >= MAX_CACHED_USERS && !oldest.done) cache.delete(oldest.value);
    }
    cache.set(userId, { cards, expiresAt: now + deps.cacheTtlMs });
  };

  return {
    fetchCards: async (userId: string, correlationId: string): Promise<Result<ReadonlyArray<CardRef>, UpstreamError>> => {
      const hit = cache.get(userId);
      if (hit && deps.nowMs() < hit.expiresAt) return ok(hit.cards);
      const path = `/cards?${new URLSearchParams({ userId })}`;
      const result = await call('users', deps, path, zListCardsForUserResponse, correlationId);
      if (!result.ok) return result;
      // Defence in depth: a card users attributes to someone else never informs this user's rows.
      const cards = result.value.cards
        .filter((c) => c.userId === userId)
        .map((c): CardRef => ({ cardId: c.cardId, expiryMonth: c.expiryMonth, expiryYear: c.expiryYear, status: c.status }));
      remember(userId, cards);
      return ok(cards);
    },
  };
};

export const createDisputesClient = (deps: UpstreamDeps) => ({
  fetchDisputes: async (
    userId: string,
    transactionIds: ReadonlyArray<string>,
    correlationId: string,
  ): Promise<Result<ReadonlyArray<DisputeRef>, UpstreamError>> => {
    const query = new URLSearchParams({ userId, transactionIds: transactionIds.join(',') });
    const result = await call('disputes', deps, `/disputes?${query}`, zLookupDisputesResponse, correlationId);
    return result.ok ? ok(result.value.items) : result;
  },
});
