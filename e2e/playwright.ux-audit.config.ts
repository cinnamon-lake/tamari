import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Standalone Playwright config for the UX/UI audit screenshot pass.
 *
 * Not part of CI. Run with:
 *   cd e2e && npx playwright test --config=playwright.ux-audit.config.ts
 *
 * Mirrors the main config's webServer (fresh DATA_DIR per run, fixed secret,
 * mock LLM from global-setup) but only picks up specs in ./ux-audit.
 * Screenshots are written to e2e/ux-audit/shots/ by the spec itself.
 *
 * Honors E2E_PORT like the other configs (parallel-safe side-by-side runs).
 */
// NixOS can't run Playwright's downloaded chromium — point at the system
// browser when it exists (local dev). Elsewhere the path is absent, so
// Playwright falls back to its own installed chromium.
const nixosChromium = '/run/current-system/sw/bin/chromium-browser';
const chromeLaunch = {
  ...devices['Desktop Chrome'],
  ...(existsSync(nixosChromium) ? { launchOptions: { executablePath: nixosChromium } } : {}),
};

const e2ePort = Number(process.env.E2E_PORT ?? 8765);
const dataDir = process.env.E2E_PORT ? `server/.test-data-${e2ePort}` : 'server/.test-data';

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  timeout: 240000,
  use: {
    baseURL: `http://localhost:${e2ePort}`,
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
    // Same cross-platform wipe as the main config (rm/mkdir break under cmd).
    command: `node e2e/scripts/reset-test-data.mjs ${dataDir} && node server/dist/main.js`,
    cwd: '..',
    url: `http://localhost:${e2ePort}`,
    reuseExistingServer: false,
    env: {
      PORT: String(e2ePort),
      HOST: '127.0.0.1',
      DATA_DIR: `./${dataDir}`,
      TAMARI_SECRET: 'e2e-test-secret',
      LOG_LEVEL: 'debug',
      DISABLE_CSRF: 'true',
    },
  },
});
