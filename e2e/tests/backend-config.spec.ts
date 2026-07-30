import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Backend Config', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens backend config and changes the config name', async ({ page }) => {
    const configName = uniqueName('E2E Config');

    const btn = page.locator('button.settings-btn:has-text("Backend Config")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-title')).toContainText('Backend Config');

    await expectNoAxeViolations(page);

    // Change the config name (first text input under the Edit section)
    const nameInput = modal.locator('input.input').first();
    await nameInput.fill(configName);
    await nameInput.blur();

    await expect(nameInput).toHaveValue(configName);

    await page.locator('.modal-overlay:has(.modal.settings-modal:has-text("Backend Config"))').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();

    // Reopen: the rename must have persisted (autosave flush on close).
    await btn.click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('input.input').first()).toHaveValue(configName);
    await expect(modal.locator('select').first()).toContainText(configName);
  });

  test('edits made through the modal UI persist (no raw-WS workaround)', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Backend Config")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
    await expect(modal).toBeVisible();

    // Drive the temperature sampler through the UI only.
    const temp = modal.locator('#sampler-temperature');
    await temp.fill('0.42');
    await temp.blur();

    // Close immediately — within the old 500ms debounce window. The
    // flush-on-close must still save.
    await page.locator('.modal-overlay:has(.modal.settings-modal:has-text("Backend Config"))').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();

    // The flush is fire-and-forget; on slow runners the reopen raced it and
    // the modal came back with the stale value. Wait for the server-side save.
    await new App(page).waitForBackendConfigSaved('temperature', 0.42);

    await btn.click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#sampler-temperature')).toHaveValue('0.42');

    // Restore the default so later specs see a clean sampler.
    await modal.locator('#sampler-temperature').fill('1');
    await page.locator('.modal-overlay:has(.modal.settings-modal:has-text("Backend Config"))').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();
  });
});
