import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

test.describe('Tools', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens tools modal and lists toolsets and templates', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Tools")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    const modal = page.locator('.tools-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-title')).toContainText('Tools');

    // Wait for any default Lua templates to render before scanning
    await expect(modal.locator('h3:has-text("Lua Templates")')).toBeVisible();
    await page.waitForTimeout(200);

    await expectNoAxeViolations(page);

    await expect(modal.locator('h3:has-text("Toolsets")')).toBeVisible();

    await page.locator('.modal-overlay:has(.tools-modal)').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();
  });
});
