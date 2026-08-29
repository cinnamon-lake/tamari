import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Local-only Playwright config — scratch space for specs you are NOT
 * committing: personal unpacked cards under development, ad-hoc regression
 * drivers, experiments.
 *
 * Specs live in `e2e/local/` (gitignored), so they cannot leak into commits;
 * they also never run in CI because the main config's projects
 * (chromium-smoke / chromium-journeys) scan ./tests* only.
 *
 * Run with:
 *
 *   npm run test:e2e:local                 # repo root; builds first
 *   cd e2e && npx playwright test --config=playwright.local.config.ts [filter]
 *
 * Supports the same E2E_PORT isolation as the stock config, so a local run
 * can proceed side-by-side with another Playwright instance. Everything not
 * overridden below (webServer, global setup/auth storage state, workers,
 * retries) is inherited from playwright.config.ts via the spread — changes to
 * the stock harness apply here automatically.
 */
// Same NixOS workaround as playwright.config.ts (system chromium in dev).
const nixosChromium = '/run/current-system/sw/bin/chromium-browser';
const chromeLaunch = {
  ...devices['Desktop Chrome'],
  ...(existsSync(nixosChromium) ? { launchOptions: { executablePath: nixosChromium } } : {}),
};

export default defineConfig({
  ...baseConfig,
  // Card specs tend toward long multi-turn sessions — journeys-sized headroom.
  timeout: 240000,
  // Keep local artifacts out of the shared test-results/playwright-report dirs.
  outputDir: '.local-results',
  reporter: [['list']],
  projects: [
    {
      name: 'local',
      testDir: './local',
      use: chromeLaunch,
    },
  ],
});
