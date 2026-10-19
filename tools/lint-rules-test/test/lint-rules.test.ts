import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const fixturesDir = new URL('../fixtures/', import.meta.url);

// Fixtures are linted as if at their real repo path so the root config globs apply.
const lintFixture = async (fixturePath: string) => {
  const eslint = new ESLint({ cwd: rootDir, overrideConfigFile: `${rootDir}eslint.config.js` });
  const source = await readFile(new URL(fixturePath, fixturesDir), 'utf8');
  const [result] = await eslint.lintText(source, { filePath: `${rootDir}${fixturePath}` });
  return result?.messages ?? [];
};

const violations = [
  ['class declaration', 'backend/disputes/src/core/bad-class.ts', 'no-restricted-syntax', /ADR-038/],
  [
    'class expression',
    'backend/disputes/src/core/bad-class-expression.ts',
    'no-restricted-syntax',
    /ADR-038/,
  ],
  ['param reassignment', 'backend/disputes/src/core/bad-param-reassign.ts', 'no-param-reassign', /parameter/],
  ['Date.now in core', 'backend/disputes/src/core/bad-date-now.ts', 'no-restricted-syntax', /Date\.now/],
  [
    'core importing adapters',
    'backend/disputes/src/core/bad-import-adapters.ts',
    'no-restricted-imports',
    /core\/ must not import/,
  ],
  [
    'use-case importing adapters',
    'backend/disputes/src/use-cases/bad-import-adapters.ts',
    'no-restricted-imports',
    /use-cases\/ must not import/,
  ],
  [
    'service importing another service',
    'backend/disputes/src/routes/bad-cross-service.ts',
    'no-restricted-imports',
    /never users/,
  ],
  [
    'non-main file importing adapters',
    'backend/disputes/src/errors.ts',
    'no-restricted-imports',
    /Only main\.ts imports adapters/,
  ],
  [
    'core importing pg',
    'backend/disputes/src/core/bad-import-pg.ts',
    'no-restricted-imports',
    /core\/ is pure/,
  ],
  [
    'frontend importing backend',
    'frontend/src/bad-backend-import.ts',
    'no-restricted-imports',
    /frontend\/ must not import/,
  ],
] as const;

describe('lint rules', () => {
  it.each(violations)('reports %s', async (_name, fixturePath, ruleId, message) => {
    const messages = await lintFixture(fixturePath);
    expect(messages.some((m) => m.ruleId === ruleId && message.test(m.message))).toBe(true);
  });

  it('reports nothing for clean functional code', async () => {
    expect(await lintFixture('backend/disputes/src/core/good.ts')).toEqual([]);
  });
});
