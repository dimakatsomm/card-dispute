import { err, ok, type Result } from '@cd/shared/fp';

export type Env = Readonly<Record<string, string | undefined>>;
export type AdminUrlError = { readonly missing: readonly string[]; readonly invalid: readonly string[] };

const PARTS = ['DB_ADMIN_HOST', 'DB_ADMIN_PORT', 'DB_ADMIN_USER', 'DB_ADMIN_PASSWORD', 'DB_ADMIN_NAME'] as const;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);

const invalid = (...names: string[]): Result<string, AdminUrlError> => err({ missing: [], invalid: names });

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

export const resolveAdminUrl = (env: Env): Result<string, AdminUrlError> => {
  const fromUrl = Boolean(env.DB_ADMIN_URL);
  let raw = env.DB_ADMIN_URL ?? '';
  if (!fromUrl) {
    const missing = PARTS.filter((k) => !env[k]);
    if (missing.length > 0) return err({ missing: ['DB_ADMIN_URL', ...missing], invalid: [] });
    const [host, port, user, password, name] = PARTS.map((k) => env[k] ?? '');
    const query = env.DB_ADMIN_SSL === 'false' ? '' : '?sslmode=verify-full';
    const auth = `${encodeURIComponent(user ?? '')}:${encodeURIComponent(password ?? '')}`;
    raw = `postgres://${auth}@${host}:${port}/${encodeURIComponent(name ?? '')}${query}`;
  }
  const url = parseUrl(raw);
  if (!url) return invalid(fromUrl ? 'DB_ADMIN_URL' : 'DB_ADMIN_HOST');
  if (!fromUrl) {
    if (url.hostname !== env.DB_ADMIN_HOST?.toLowerCase()) return invalid('DB_ADMIN_HOST');
    if (url.port !== env.DB_ADMIN_PORT) return invalid('DB_ADMIN_PORT');
  }
  if (!LOCAL_HOSTS.has(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full') {
    return invalid(fromUrl ? 'DB_ADMIN_URL' : 'DB_ADMIN_SSL');
  }
  return ok(raw);
};
