import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: {
    browserName: 'chromium',
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    viewport: { width: 1100, height: 720 },
    locale: 'en-US',
    colorScheme: 'dark',
    screenshot: process.env.CSV_VALIDATION_FILE ? 'off' : 'only-on-failure',
    trace: process.env.CSV_VALIDATION_FILE ? 'off' : 'retain-on-failure',
  },
});
