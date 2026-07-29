import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for the UX/UI audit screenshot pass.
 *
 * Not part of CI. Run with:
 *   cd e2e && npx playwright test --config=playwright.ux-audit.config.ts
 *
 * Mirrors the main config's webServer (fresh DATA_DIR per run, fixed secret,
 * mock LLM from global-setup) but only picks up specs in ./ux-audit.
 * Screenshots are written to e2e/ux-audit/shots/ by the spec itself.
 */
const chromeLaunch = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    executablePath: '/run/current-system/sw/bin/chromium-browser',
  },
};

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  timeout: 240000,
  use: {
    baseURL: 'http://localhost:8765',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'ux-audit',
      testDir: './ux-audit',
      use: chromeLaunch,
    },
  ],

  webServer: {
    command: 'rm -rf server/.test-data && mkdir -p server/.test-data && node server/dist/main.js',
    cwd: '..',
    url: 'http://localhost:8765',
    reuseExistingServer: false,
    env: {
      PORT: '8765',
      HOST: '127.0.0.1',
      DATA_DIR: './server/.test-data',
      TAMARI_SECRET: 'e2e-test-secret',
      LOG_LEVEL: 'debug',
      DISABLE_CSRF: 'true',
    },
  },
});
