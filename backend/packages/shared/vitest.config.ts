import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@cd/shared', include: ['test/**/*.test.ts'] },
});
