import { err, ok, type Result } from '@cd/shared/fp';
import { z } from 'zod';
import { createHttpClient, type Fetch } from './http-client.ts';

export type TokenError = { readonly kind: 'token_unavailable'; readonly detail: string };

export type ServiceTokenProviderDeps = {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly timeoutMs?: number;
};

export type GetTokenOptions = { readonly signal?: AbortSignal };

export type ServiceTokenProvider = {
  readonly getToken: (options?: GetTokenOptions) => Promise<Result<string, TokenError>>;
  readonly invalidate: (rejectedToken: string) => void;
};

const MAX_REFRESH_MARGIN_MS = 60_000;
const INVALIDATE_COOLDOWN_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5000;

const formEncode = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2);

const tokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

type Cached = { readonly token: string; readonly refreshAt: number };

export const createServiceTokenProvider = (deps: ServiceTokenProviderDeps): ServiceTokenProvider => {
  const http = createHttpClient({ fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  // RFC 6749 s2.3.1: id and secret are form-urlencoded (space as +) before Basic encoding.
  const basic = Buffer.from(`${formEncode(deps.clientId)}:${formEncode(deps.clientSecret)}`).toString('base64');
  let cached: Cached | undefined;
  let inflight: Promise<Result<string, TokenError>> | undefined;
  let lastForcedAt: number | undefined;

  const unavailable = (detail: string) => err<TokenError>({ kind: 'token_unavailable', detail });

  const fetchToken = async (): Promise<Result<string, TokenError>> => {
    const res = await http.request({
      url: deps.tokenUrl,
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: deps.scopes.join(' ') }).toString(),
    });
    if (!res.ok) return unavailable(res.error.detail);
    if (res.value.status !== 200) return unavailable(`token endpoint responded ${res.value.status}`);
    const parsed = tokenResponseSchema.safeParse(res.value.body);
    if (!parsed.success) return unavailable('unparseable token response');
    cached = {
      token: parsed.data.access_token,
      refreshAt:
        deps.now() +
        parsed.data.expires_in * 1000 -
        Math.min(MAX_REFRESH_MARGIN_MS, parsed.data.expires_in * 500),
    };
    return ok(cached.token);
  };

  // The shared fetch is bound only by the provider timeout; a caller's signal releases just that caller.
  const abandonOn = (
    pending: Promise<Result<string, TokenError>>,
    signal: AbortSignal | undefined,
  ): Promise<Result<string, TokenError>> =>
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
    // Only the token that was rejected is dropped, and not while a refresh runs or right after a forced one,
    // so a sustained rejection cannot amplify into a token-endpoint storm.
    invalidate: (rejectedToken) => {
      if (inflight || cached?.token !== rejectedToken) return;
      const now = deps.now();
      if (lastForcedAt !== undefined && now - lastForcedAt < INVALIDATE_COOLDOWN_MS) return;
      lastForcedAt = now;
      cached = undefined;
    },
    getToken: async (options) => {
      if (cached && deps.now() < cached.refreshAt) return ok(cached.token);
      // Single-flight: Cognito bills per token request.
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return abandonOn(inflight, options?.signal);
    },
  };
};
