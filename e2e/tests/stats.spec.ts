import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

test.describe('Statistics', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens stats modal and displays aggregate counts', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Stats")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    const modal = page.locator('.stats-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-title')).toContainText('Statistics');

    await expect(modal.locator('.stats-grid')).toBeVisible({ timeout: 5000 });

    await expectNoAxeViolations(page);

    await expect(modal.locator('.stat-card:has-text("Characters")')).toBeVisible();
    await expect(modal.locator('.stat-card:has-text("Chats")')).toBeVisible();
    await expect(modal.locator('.stat-card:has-text("Messages")')).toBeVisible();

    await page.locator('.modal-overlay:has(.stats-modal)').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();
  });
});
