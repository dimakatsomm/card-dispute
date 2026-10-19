import { CORRELATION_HEADER } from '@cd/shared';
import { err, ok, type Result } from '@cd/shared/fp';

export type Fetch = typeof globalThis.fetch;

export type HttpRequest = {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly correlationId?: string;
};

export type HttpResponse = { readonly status: number; readonly body: unknown };

export type HttpError = {
  readonly kind: 'timeout' | 'network' | 'server_error';
  readonly detail: string;
};

export type HttpClient = {
  readonly request: (req: HttpRequest) => Promise<Result<HttpResponse, HttpError>>;
};

export type HttpClientDeps = { readonly fetch: Fetch; readonly timeoutMs?: number };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const attempt = async (
  fetchFn: Fetch,
  timeoutMs: number,
  req: HttpRequest,
): Promise<Result<HttpResponse, HttpError>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(req.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    if (req.correlationId) headers[CORRELATION_HEADER] = req.correlationId;
    const res = await fetchFn(req.url, {
      method: req.method ?? 'GET',
      headers,
      redirect: 'error',
      ...(req.body === undefined ? {} : { body: req.body }),
      signal: controller.signal,
    });
    const text = await res.text();
    return res.status >= 500
      ? err({ kind: 'server_error', detail: `upstream responded ${res.status}` })
      : ok({ status: res.status, body: parseJson(text) });
  } catch (error) {
    return controller.signal.aborted
      ? err({ kind: 'timeout', detail: `no response within ${timeoutMs}ms` })
      : err({ kind: 'network', detail: error instanceof Error ? error.message : 'network error' });
  } finally {
    clearTimeout(timer);
  }
};

export const createHttpClient = ({ fetch: fetchFn, timeoutMs = 2000 }: HttpClientDeps): HttpClient => ({
  request: async (req) => {
    const first = await attempt(fetchFn, timeoutMs, req);
    return !first.ok && (req.method ?? 'GET') === 'GET' ? attempt(fetchFn, timeoutMs, req) : first;
  },
});
