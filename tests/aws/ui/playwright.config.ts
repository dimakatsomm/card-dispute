import { defineConfig, devices } from '@playwright/test';

// Trace, video and screenshots stay off: the hosted login page holds the test password. The spec takes failure screenshots itself, never on the login page.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['WEB_ORIGIN'],
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
