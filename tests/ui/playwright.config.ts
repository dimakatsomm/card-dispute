import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['UI_BASE_URL'] ?? 'http://localhost:5173',
    headless: true,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
