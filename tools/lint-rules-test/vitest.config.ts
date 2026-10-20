import { defineConfig } from 'vitest/config';

// ESLint cold start with type info is slow when the whole workspace tests in parallel.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
