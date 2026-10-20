import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@cd/retention-sweeper',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
