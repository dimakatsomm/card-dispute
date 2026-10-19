import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@cd/disputes',
    include: ['test/**/*.test.ts', 'migrations/test/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
