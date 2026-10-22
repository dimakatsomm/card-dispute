import { err, ok, type Result } from '@cd/shared/fp';

export type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status'>>;

export type Expected = 401 | 403 | 'unreachable';
export type Observed = number | 'unreachable' | 'error';

export type CheckResult = {
  readonly check: string;
  readonly expected: Expected;
  readonly observed: Observed;
  readonly code: string | null;
  readonly pass: boolean;
};

type Outcome = { readonly observed: Observed; readonly code: string | null };

// Only a refused or dropped connection proves the SG denial; DNS, URL or TLS failures prove nothing.
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'AbortError',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const codeOf = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;

const failureCode = (e: unknown): string => {
  if (!(e instanceof Error)) return 'UnknownError';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return e.name;
  const cause = e.cause;
  const nested = typeof cause === 'object' && cause !== null ? (cause as { errors?: unknown }).errors : undefined;
  return codeOf(e) ?? codeOf(cause) ?? (Array.isArray(nested) ? codeOf(nested[0]) : undefined) ?? e.name;
};

export const parseHttpUrl = (raw: string, protocols: ReadonlyArray<string> = ['http:', 'https:']): URL | null => {
  try {
    const url = new URL(raw);
    return protocols.includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

export type TokenError = { readonly kind: 'token'; readonly which: 'user' | 'service'; readonly reason: string };

export type ProbeDeps = {
  readonly fetch: Fetch;
  readonly timeoutMs: number;
  readonly userToken: () => Promise<Result<string, TokenError>>;
  readonly serviceToken: () => Promise<Result<string, TokenError>>;
};

type Request = {
  readonly check: string;
  readonly expected: Expected;
  readonly method: 'GET' | 'PUT';
  readonly url: string;
  readonly token?: string;
  readonly body?: unknown;
};

const observe = async (deps: ProbeDeps, req: Request): Promise<Outcome> => {
  if (parseHttpUrl(req.url) === null) return { observed: 'error', code: 'ERR_INVALID_URL' };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (req.token !== undefined) headers.authorization = `Bearer ${req.token}`;
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await deps.fetch(req.url, {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs),
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
    return { observed: res.status, code: null };
  } catch (e) {
    const code = failureCode(e);
    return { observed: UNREACHABLE_CODES.has(code) ? 'unreachable' : 'error', code };
  }
};

const run = async (deps: ProbeDeps, req: Request): Promise<CheckResult> => {
  const { observed, code } = await observe(deps, req);
  return { check: req.check, expected: req.expected, observed, code, pass: observed === req.expected };
};

export const allPassed = (results: ReadonlyArray<CheckResult>): boolean =>
  results.length > 0 && results.every((r) => r.pass);

const join = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;

// Mode A (dev-tools SG): any HTTP answer, even 404, means the SG matrix let us through.
export const probeUnreachable =
  (deps: ProbeDeps) =>
  (baseUrls: ReadonlyArray<string>): Promise<ReadonlyArray<CheckResult>> =>
    Promise.all(
      baseUrls.map((base) => run(deps, { check: `unreachable ${base}`, expected: 'unreachable', method: 'GET', url: join(base, '/health') })),
    );

export type DenialTargets = {
  readonly serviceBaseUrl: string;
  readonly userId: string;
  readonly unknownId: () => string;
};

// Mode B (dispute-notifier SG): the service port answers, but the token decides (ADR-026, V-10).
export const probeDenials =
  (deps: ProbeDeps) =>
  async (targets: DenialTargets): Promise<Result<ReadonlyArray<CheckResult>, TokenError>> => {
    const [user, service] = await Promise.all([deps.userToken(), deps.serviceToken()]);
    if (!user.ok) return user;
    if (!service.ok) return service;
    const listPath = `/disputes?userId=${targets.userId}&transactionIds=${targets.unknownId()}`;
    const evidencePath = `/dispute/${targets.unknownId()}/evidence/${targets.unknownId()}`;
    const base = targets.serviceBaseUrl;
    const results = await Promise.all([
      run(deps, { check: 'no token on GET /disputes', expected: 401, method: 'GET', url: join(base, listPath) }),
      run(deps, { check: 'user token on GET /disputes', expected: 403, method: 'GET', url: join(base, listPath), token: user.value }),
      run(deps, {
        check: 'svc-notifier token on PUT /dispute/{id}/evidence/{id}',
        expected: 403,
        method: 'PUT',
        url: join(base, evidencePath),
        token: service.value,
        body: { result: 'REJECTED', reason: 'MALWARE' },
      }),
    ]);
    return ok(results);
  };

export const tokenError = (which: 'user' | 'service', reason: string): Result<never, TokenError> =>
  err({ kind: 'token', which, reason });
