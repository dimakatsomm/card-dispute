import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const DATE_MATHS = /Date\.UTC|\.get(UTC)?(FullYear|Month|Date)\(|\.set(UTC)?(FullYear|Month|Date)\(|expiry_?(month|year)\s*[<>]|expiry(Month|Year)\s*[<>]/;

const sourceFiles = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, f));

describe('card expiry has a single source of truth', () => {
  it('src does no date maths of its own and derives expired only via isCardExpired from @cd/dispute-domain', async () => {
    const files = await Promise.all((await sourceFiles()).map(async (f) => ({ f, text: await readFile(f, 'utf8') })));

    expect(files.filter(({ text }) => DATE_MATHS.test(text)).map(({ f }) => f)).toEqual([]);
    const callers = files.filter(({ text }) => /\bisCardExpired\(/.test(text));
    expect(callers).toHaveLength(1);
    expect(callers[0]?.text).toMatch(/import \{[^}]*\bisCardExpired\b[^}]*\} from '@cd\/dispute-domain'/);
  });
});
