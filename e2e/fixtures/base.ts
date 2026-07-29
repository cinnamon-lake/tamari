/**
 * Shared base fixture for browser E2E specs.
 *
 * Drop-in replacement for `@playwright/test`: re-exports everything from it
 * but overrides `test` with an extended version that collects Chromium V8
 * coverage (client-side JS) when E2E_COVERAGE is set. Without the env var the
 * auto fixture is a no-op, so normal runs are unaffected.
 *
 * Coverage is handed to monocart-reporter via addCoverageReport() and merged
 * with the server's Node V8 coverage (see playwright.config.ts) into a single
 * source-mapped report at e2e/coverage/.
 */
import { test as base } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';

const coverageEnabled = !!process.env.E2E_COVERAGE;

export const test = base.extend<{ autoCoverage: void }>({
  autoCoverage: [
    async ({ page }, use, testInfo) => {
      if (!coverageEnabled) {
        await use();
        return;
      }
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      try {
        const jsCoverage = await page.coverage.stopJSCoverage();
        await addCoverageReport(jsCoverage, testInfo);
      } catch {
        // Page already closed (e.g. test closed it explicitly) — coverage for
        // this test is lost, but don't fail the test run over reporting.
      }
    },
    { auto: true },
  ],
});

export * from '@playwright/test';
