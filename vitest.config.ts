import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ['backend/*/vitest.config.ts', 'backend/*/*/vitest.config.ts', 'frontend/vitest.config.ts', 'tools/*/vitest.config.ts'],
  },
});
