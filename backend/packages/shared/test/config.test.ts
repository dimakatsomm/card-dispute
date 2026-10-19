import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, serverConfigSchema } from '../src/config.ts';

const schema = z.object({
  DB_URL: z.string().min(1),
  TOKEN_TTL: z.coerce.number().int().positive(),
  MODE: z.enum(['a', 'b']),
});

describe('loadConfig', () => {
  it('returns the parsed, coerced config and defaults the server ports to 8080 and 8081', () => {
    expect(loadConfig(schema, { DB_URL: 'x', TOKEN_TTL: '15', MODE: 'a' })).toEqual({
      DB_URL: 'x',
      TOKEN_TTL: 15,
      MODE: 'a',
    });
    expect(loadConfig(serverConfigSchema, {})).toMatchObject({ PUBLIC_PORT: 8080, SERVICE_PORT: 8081 });
  });

  it('throws listing every missing or invalid key, without echoing values', () => {
    let message = '';
    try {
      loadConfig(schema, { TOKEN_TTL: 'not-a-number-s3cret', MODE: 'zzz-s3cret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('DB_URL');
    expect(message).toContain('TOKEN_TTL');
    expect(message).toContain('MODE');
    expect(message).not.toContain('s3cret');
  });
});
