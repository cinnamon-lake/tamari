/**
 * Journey fixture for long-running, realistic browser E2E tests.
 *
 * Wraps the base Playwright `test` with an `app` fixture that:
 *   1. logs in once,
 *   2. points the active backend at the deterministic mock LLM (started in
 *      global-setup), so generation-driven flows work without API keys, and
 *   3. hands the test an `App` with the full flow vocabulary bound to the page.
 *
 * The active backend config is reset on teardown so other specs never see the
 * mock URL. Journey specs use `journeyTest` + the re-exported `expect` instead
 * of the raw `@playwright/test` pair.
 */
import { test as base, expect } from './base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

export const journeyTest = base.extend<{ app: App }>({
  app: async ({ page }, use) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    await use(app);
    await resetBackendConfig(page);
  },
});

export { expect };
