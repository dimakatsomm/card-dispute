import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@cd/dispute-notifier',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
