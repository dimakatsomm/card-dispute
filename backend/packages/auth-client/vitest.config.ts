import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@cd/auth-client', include: ['test/**/*.test.ts'] },
});
