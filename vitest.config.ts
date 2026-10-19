// vitest 5 uses `test.projects` (vitest.workspace.ts was replaced). Each package owns its own
// vitest.config.ts and runs via `pnpm -r test`; this root config only lets editors and `vitest` at the
// repo root discover them.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ['backend/*/vitest.config.ts', 'backend/*/*/vitest.config.ts', 'frontend/vitest.config.ts', 'tools/*/vitest.config.ts'],
  },
});
