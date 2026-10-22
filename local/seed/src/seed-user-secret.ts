export type SeedUserSecret = { readonly username: string; readonly password: string };

export const encodeSeedUserSecret = (secret: SeedUserSecret): string =>
  JSON.stringify({ username: secret.username, password: secret.password });

export const parseSeedUserSecret = (raw: string | undefined): SeedUserSecret | null => {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    if (typeof value !== 'object' || value === null) return null;
    const { username, password } = value as Record<string, unknown>;
    return typeof username === 'string' && username !== '' && typeof password === 'string' && password !== ''
      ? { username, password }
      : null;
  } catch {
    return null;
  }
};
