import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@cd/evidence-intake',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
