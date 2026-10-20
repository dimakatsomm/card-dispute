import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@cd/e2e',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
