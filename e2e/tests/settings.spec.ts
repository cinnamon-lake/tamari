import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens settings and toggles a setting', async ({ page }) => {
    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settings = page.locator('.settings-modal');
    await expect(settings).toBeVisible();
    await expect(settings.locator('.modal-title')).toContainText('Settings');

    // Toggle a simple checkbox setting
    const checkbox = settings.locator('label.checkbox-row:has-text("Show message token counts") input[type="checkbox"]');
    const before = await checkbox.isChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    await expectNoAxeViolations(page);

    // Close the modal by clicking the overlay backdrop
    await page.locator('.modal-overlay:has(.settings-modal)').click({ position: { x: 0, y: 0 } });
    await expect(settings).not.toBeVisible();

    // Restore the toggle: messageTokenCountEnabled is global, and the "Ntk"
    // badge it adds to bubble headers breaks whole-bubble text assertions in
    // later specs (settings persist on the shared e2e server).
    await page.locator('button.settings-btn:has-text("Settings")').click();
    await expect(settings).toBeVisible();
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: before });
    await page.locator('.modal-overlay:has(.settings-modal)').click({ position: { x: 0, y: 0 } });
    await expect(settings).not.toBeVisible();
  });

  test('adds and removes a custom stopping string', async ({ page }) => {
    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settings = page.locator('.settings-modal');
    await expect(settings).toBeVisible();

    // Scroll to the Generation section
    await settings.locator('h3:has-text("Generation")').scrollIntoViewIfNeeded();

    // Add a new stop string
    const initialCount = await settings.locator('div[id^="stop-str-"] input[type="text"]').count();
    await settings.locator('button:has-text("Add stop string")').click();
    await expect(settings.locator('div[id^="stop-str-"] input[type="text"]')).toHaveCount(initialCount + 1);
    // Remove the stop string we just added. We intentionally do not fill the
    // input because the controlled input's onChange causes Solid to reconcile
    // the row and the remove button handle can become stale in Playwright.
    const removeBtn = settings.locator('div[id^="stop-str-"] button[title="Remove"]').last();
    await removeBtn.scrollIntoViewIfNeeded();
    await removeBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await expect(settings.locator('div[id^="stop-str-"] input[type="text"]')).toHaveCount(initialCount);
  });

  test('toggles rolling memory settings', async ({ page }) => {
    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settings = page.locator('.settings-modal');
    await expect(settings).toBeVisible();

    // Scroll to the Memory section
    await settings.locator('h3:has-text("Memory")').scrollIntoViewIfNeeded();

    // Toggle memory enabled
    const checkbox = settings.locator('label.checkbox-row:has-text("Enable rolling memory") input[type="checkbox"]');
    const before = await checkbox.isChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });

    // Change update interval
    const intervalInput = settings.locator('label:has-text("Update interval") input[type="number"]');
    await intervalInput.fill('7');
    await expect(intervalInput).toHaveValue('7');

    // Change depth
    const depthInput = settings.locator('label:has-text("Depth") input[type="number"]');
    await depthInput.fill('15');
    await expect(depthInput).toHaveValue('15');

    await expectNoAxeViolations(page);
  });
});
