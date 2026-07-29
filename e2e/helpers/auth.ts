/**
 * Authentication helpers for E2E tests.
 */

import { expect, type Page, type Locator } from '@playwright/test';

export const TEST_SECRET = 'e2e-test-secret';

/**
 * Log in via the auth modal when it shows. Contexts are usually
 * pre-authenticated via storageState (see global-setup.ts), in which case the
 * app boots straight to the shell and this is a no-op beyond the goto.
 */
export async function login(page: Page, secret: string = TEST_SECRET): Promise<void> {
  await page.goto('/');
  const authInput = page.locator('[data-testid="auth-input"]');
  await expect(authInput.or(page.locator('.app-shell'))).toBeVisible({ timeout: 10000 });
  if (await authInput.isVisible()) {
    await authInput.fill(secret);
    await page.locator('[data-testid="auth-submit"]').click();
  }
  await expectAppShell(page);
}

/**
 * Assert that the main app shell is visible (auth succeeded).
 */
export async function expectAppShell(page: Page): Promise<Locator> {
  const shell = page.locator('.app-shell');
  await shell.waitFor({ state: 'visible', timeout: 10000 });
  return shell;
}

/**
 * Assert that the auth modal is visible.
 */
export async function expectAuthModal(page: Page): Promise<Locator> {
  const modal = page.locator('.auth-modal');
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  return modal;
}
