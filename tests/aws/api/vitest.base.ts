import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export const configFor = (include: readonly string[], exclude: readonly string[]) =>
  defineConfig({
    root: fileURLToPath(new URL('..', import.meta.url)),
    test: {
      name: '@cd/e2e-aws',
      include: [...include],
      exclude: ['**/node_modules/**', ...exclude],
      globalSetup: ['api/global-setup.ts'],
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  });
