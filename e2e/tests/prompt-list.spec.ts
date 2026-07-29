import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

test.describe('Prompt List', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens prompt list and toggles a prompt', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Prompt List")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Prompt List' });
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-title')).toContainText('Prompt List');

    await expectNoAxeViolations(page);

    // Toggle the first prompt's enabled checkbox
    const firstPrompt = modal.locator('.prompt-item').first();
    const checkbox = firstPrompt.locator('input[type="checkbox"][title="Enabled"]').first();
    const before = await checkbox.isChecked().catch(() => false);
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await page.locator('.modal-overlay:has(.modal.settings-modal:has-text("Prompt List"))').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();
  });
});
