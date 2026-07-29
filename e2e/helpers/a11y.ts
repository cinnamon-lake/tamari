/**
 * Accessibility helpers for browser E2E tests.
 *
 * Uses axe-core via @axe-core/playwright to scan pages and components.
 */

import { type Page, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Wait for entrance animations to settle before scanning.
 *
 * Entrance animations (fade-in, modal-in, toast-in) animate opacity 0→1 with
 * no fill-mode. An axe scan fired mid-animation composites text against a
 * partially-transparent surface and reports a false low-contrast violation
 * (the settled state passes). Waits until no finite CSS animation is running
 * and every modal-layer / toast element has reached full opacity. Non-fatal
 * timeout so a stuck animation still gets scanned (real violations surface).
 */
async function waitForAnimationsToSettle(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        // (a) No finite CSS animation still running. Infinite animations
        // (blink cursor, skeleton pulse) are ignored.
        const anims = document.getAnimations();
        const animRunning = anims.some((a) => {
          const t = a.effect?.getTiming?.();
          return t?.iterations !== Infinity && a.playState !== 'finished';
        });
        if (animRunning) return false;
        // (b) No modal-layer / toast element mid-transition at <full opacity
        // (transition-based fades aren't captured by getAnimations).
        const els = document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"], .modal-overlay, .popup-backdrop, .group-panel-overlay, .toast',
        );
        for (const el of els) {
          if (Number(getComputedStyle(el).opacity) < 1) return false;
        }
        return true;
      },
      undefined,
      { timeout: 1500 },
    )
    .catch(() => {
      /* non-fatal — scan anyway so real violations still surface */
    });
}

/**
 * Run an axe scan on the whole page and assert no violations.
 *
 * The `color-contrast` rule is **enabled by default** — the design tokens are
 * tuned so every text/bg pair meets WCAG AA (4.5:1). This makes any future
 * low-contrast regression a CI failure. Structural a11y issues (missing labels,
 * landmarks, dialog roles, etc.) are also enforced. Pass
 * `enableColorContrast: false` to opt OUT for scopes axe can't measure reliably
 * (e.g. text over user-supplied images/gradients, third-party widgets).
 *
 * @param page Playwright page
 * @param options.exclude CSS selectors to exclude from the scan (e.g. third-party widgets)
 * @param options.include Optional CSS selector to scope the scan to a specific region
 * @param options.enableColorContrast Include the color-contrast rule (default true)
 */
export async function expectNoAxeViolations(
  page: Page,
  options: { exclude?: string[]; include?: string; enableColorContrast?: boolean } = {},
) {
  await waitForAnimationsToSettle(page);
  const builder = await buildScanner(page, options);
  const accessibilityScanResults = await builder.analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
}

/**
 * Run an axe scan and return violations for inspection instead of asserting.
 */
export async function getAxeViolations(
  page: Page,
  options: { exclude?: string[]; include?: string; enableColorContrast?: boolean } = {},
) {
  await waitForAnimationsToSettle(page);
  const builder = await buildScanner(page, options);
  const accessibilityScanResults = await builder.analyze();
  return accessibilityScanResults.violations;
}

/** Shared axe-builder setup: contrast toggle + include/exclude scoping. */
async function buildScanner(
  page: Page,
  options: { exclude?: string[]; include?: string; enableColorContrast?: boolean },
): Promise<AxeBuilder> {
  const enableContrast = options.enableColorContrast !== false;
  let builder = new AxeBuilder({ page });
  if (!enableContrast) {
    builder = builder.disableRules(['color-contrast']);
  }

  if (options.include) {
    builder = builder.include(options.include);
  }

  if (options.exclude) {
    for (const selector of options.exclude) {
      builder = builder.exclude(selector);
    }
  }

  return builder;
}
