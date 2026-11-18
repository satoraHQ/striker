// Browser end-to-end tests for the web app on the regtest stack (`npm run regtest -- start` first).
// Global setup starts Striker (:7190) and a maker bot; the web app is the production build, served
// by `vite preview` and talking to Striker cross-origin, as deployed.
import { defineConfig, devices } from '@playwright/test';

export const STRIKER_PORT = 7190, WEB_PORT = 5183;

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The service worker would hide API calls from page.route; the PWA test opts back in.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${WEB_PORT} --strictPort`,
    url: `http://localhost:${WEB_PORT}`,
    env: { VITE_STRIKER_URL: `http://localhost:${STRIKER_PORT}` },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
