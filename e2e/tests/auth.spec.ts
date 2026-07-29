import { test, expect } from '../fixtures/base.js';
import { login, expectAuthModal, TEST_SECRET } from '../helpers/auth.js';

// These tests exercise the auth modal itself — run them unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Authentication', () => {
  test('shows auth modal when not authenticated', async ({ page }) => {
    await page.goto('/');
    const modal = await expectAuthModal(page);
    await expect(modal.locator('h2')).toHaveText('Authentication Required');
  });

  test('logs in with correct secret', async ({ page }) => {
    await login(page);
    await expect(page.locator('.app-shell')).toBeVisible();
  });

  test('shows error for incorrect secret', async ({ page }) => {
    await page.goto('/');
    const authInput = page.locator('[data-testid="auth-input"]');
    await authInput.fill('wrong-secret');
    await page.locator('[data-testid="auth-submit"]').click();
    await expect(page.locator('.auth-error')).toBeVisible();
  });
});
