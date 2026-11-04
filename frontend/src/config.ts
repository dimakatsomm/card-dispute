import { err, ok, type Result } from './app/result';

export type AppConfig = {
  readonly apiBase: string;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly oidcRedirectUri: string;
  readonly oidcLogoutUrl: string;
  readonly oidcPostLogoutUri: string;
  readonly agentSignIn: AgentSignInConfig | null;
};

export type AgentSignInConfig = { readonly clientId: string; readonly redirectUri: string };

export type ConfigField = Exclude<keyof AppConfig, 'agentSignIn'> | 'oidcAgentClientId' | 'oidcAgentRedirectUri';

export type ConfigError =
  | { readonly kind: 'MISSING_CONFIG' }
  | { readonly kind: 'INVALID_FIELD'; readonly field: ConfigField };

declare global {
  interface Window {
    __APP_CONFIG__?: unknown;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

// The API must stay same-origin (ADR-037): only a root-relative path, never a host.
const isSameOriginPath = (value: unknown): value is string =>
  nonEmpty(value) && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');

const isLocalHost = (url: URL): boolean => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

const isAbsoluteUrl = (value: unknown): value is string => {
  if (!nonEmpty(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url));
};

type Check = readonly [ConfigField, (value: unknown) => value is string];

const checks: ReadonlyArray<Check> = [
  ['apiBase', isSameOriginPath],
  ['oidcIssuer', isAbsoluteUrl],
  ['oidcClientId', nonEmpty],
  ['oidcRedirectUri', isAbsoluteUrl],
  ['oidcLogoutUrl', isAbsoluteUrl],
  ['oidcPostLogoutUri', isAbsoluteUrl],
];

const agentChecks: ReadonlyArray<Check> = [
  ['oidcAgentClientId', nonEmpty],
  ['oidcAgentRedirectUri', isAbsoluteUrl],
];

// The back office is optional (off until its OIDC client exists), but it is all or nothing.
const agentSignInFrom = (source: Readonly<Record<string, unknown>>): Result<AgentSignInConfig | null, ConfigError> => {
  if (agentChecks.every(([field]) => source[field] === undefined)) return ok(null);
  const invalid = agentChecks.find(([field, check]) => !check(source[field]));
  if (invalid) return err({ kind: 'INVALID_FIELD', field: invalid[0] });
  return ok({ clientId: String(source['oidcAgentClientId']), redirectUri: String(source['oidcAgentRedirectUri']) });
};

export const parseConfig = (source: unknown): Result<AppConfig, ConfigError> => {
  if (!isRecord(source)) return err({ kind: 'MISSING_CONFIG' });
  const invalid = checks.find(([field, check]) => !check(source[field]));
  if (invalid) return err({ kind: 'INVALID_FIELD', field: invalid[0] });
  const agentSignIn = agentSignInFrom(source);
  if (!agentSignIn.ok) return agentSignIn;
  return ok({
    apiBase: String(source['apiBase']).replace(/\/+$/, ''),
    oidcIssuer: String(source['oidcIssuer']),
    oidcClientId: String(source['oidcClientId']),
    oidcRedirectUri: String(source['oidcRedirectUri']),
    oidcLogoutUrl: String(source['oidcLogoutUrl']),
    oidcPostLogoutUri: String(source['oidcPostLogoutUri']),
    agentSignIn: agentSignIn.value,
  });
};

export const loadConfig = (win: Pick<Window, '__APP_CONFIG__'>): Result<AppConfig, ConfigError> =>
  parseConfig(win.__APP_CONFIG__);
