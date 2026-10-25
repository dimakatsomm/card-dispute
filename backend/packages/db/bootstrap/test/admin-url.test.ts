import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAdminUrl } from '../admin-url.ts';
import { ROLES } from '../bootstrap.ts';

const parts = {
  DB_ADMIN_HOST: 'aurora.cluster-x.eu-north-1.rds.amazonaws.com',
  DB_ADMIN_PORT: '5432',
  DB_ADMIN_USER: 'cd admin',
  DB_ADMIN_PASSWORD: 'p@ss:w/rd?#%&=+ ',
  DB_ADMIN_NAME: 'disputes',
};

describe('resolveAdminUrl', () => {
  it('keeps DB_ADMIN_URL as is when set', () => {
    const url = 'postgres://u:p@localhost:5432/postgres';
    expect(resolveAdminUrl({ DB_ADMIN_URL: url, ...parts })).toEqual({ ok: true, value: url });
  });

  it('assembles a URL that round-trips special characters and adds sslmode=verify-full', () => {
    const result = resolveAdminUrl(parts);
    if (!result.ok) throw new Error('expected ok');
    const url = new URL(result.value);
    expect(decodeURIComponent(url.username)).toBe(parts.DB_ADMIN_USER);
    expect(decodeURIComponent(url.password)).toBe(parts.DB_ADMIN_PASSWORD);
    expect([url.hostname, url.port, url.pathname]).toEqual([parts.DB_ADMIN_HOST, '5432', '/disputes']);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
  });

  it('omits sslmode for local hosts only when DB_ADMIN_SSL is "false"', () => {
    const local = { ...parts, DB_ADMIN_HOST: 'localhost' };
    const off = resolveAdminUrl({ ...local, DB_ADMIN_SSL: 'false' });
    const on = resolveAdminUrl({ ...local, DB_ADMIN_SSL: 'true' });
    expect(off.ok && off.value).not.toContain('sslmode');
    expect(on.ok && on.value).toContain('sslmode=verify-full');
  });

  it('refuses to disable TLS for a remote host', () => {
    expect(resolveAdminUrl({ ...parts, DB_ADMIN_SSL: 'false' })).toEqual({
      ok: false,
      error: { missing: [], invalid: ['DB_ADMIN_SSL'] },
    });
  });

  it.each(['?sslmode=no-verify', '?sslmode=disable', ''])('refuses DB_ADMIN_URL with "%s" on a remote host', (q) => {
    const result = resolveAdminUrl({ DB_ADMIN_URL: `postgres://u:p@${parts.DB_ADMIN_HOST}:5432/d${q}` });
    expect(result).toEqual({ ok: false, error: { missing: [], invalid: ['DB_ADMIN_URL'] } });
  });

  it('allows a local DB_ADMIN_URL without SSL', () => {
    expect(resolveAdminUrl({ DB_ADMIN_URL: 'postgres://u:p@localhost:55432/d' }).ok).toBe(true);
  });

  it('rejects a host that does not survive URL assembly intact', () => {
    const result = resolveAdminUrl({ ...parts, DB_ADMIN_HOST: 'evil.example/x@localhost' });
    expect(result).toEqual({ ok: false, error: { missing: [], invalid: ['DB_ADMIN_HOST'] } });
  });

  it('names the missing variables only', () => {
    const result = resolveAdminUrl({ DB_ADMIN_HOST: 'h', DB_ADMIN_PASSWORD: 'secret-value' });
    expect(result).toEqual({
      ok: false,
      error: { missing: ['DB_ADMIN_URL', 'DB_ADMIN_PORT', 'DB_ADMIN_USER', 'DB_ADMIN_NAME'], invalid: [] },
    });
  });
});

describe('bootstrap main', () => {
  const runMain = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../main.ts', import.meta.url))], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const rolePasswords = Object.fromEntries(ROLES.map((r) => [`DB_PASSWORD_${r.toUpperCase()}`, `role-pw-${r}-unique`]));

  it('exits 1 naming the missing variables and printing no value', () => {
    const { status, output } = runMain({ DB_ADMIN_HOST: 'h', DB_ADMIN_PASSWORD: 'admin-pw-unique' });
    expect(status).toBe(1);
    expect(output).toContain('DB_ADMIN_USER');
    expect(output).not.toContain('admin-pw-unique');
  });

  it('never prints the admin or role passwords when the connection fails', () => {
    const { status, output } = runMain({
      ...parts,
      DB_ADMIN_HOST: '127.0.0.1',
      DB_ADMIN_PORT: '1',
      DB_ADMIN_PASSWORD: 'admin-pw-unique',
      DB_ADMIN_SSL: 'false',
      ...rolePasswords,
    });
    expect(status).toBe(1);
    expect(output).not.toMatch(/admin-pw-unique|role-pw-/);
  });
});
