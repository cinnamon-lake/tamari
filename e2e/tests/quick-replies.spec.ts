import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Quick Replies', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('creates a global quick reply', async ({ page }) => {
    const label = uniqueName('E2E QR');

    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settings = page.locator('.settings-modal');
    await expect(settings).toBeVisible();

    // Scroll to the Quick Replies section
    await settings.locator('h3:has-text("Quick Replies")').scrollIntoViewIfNeeded();
    await expect(settings.locator('h3:has-text("Quick Replies")')).toBeVisible();

    // Open the quick reply editor
    await settings.locator('button:has-text("Add Quick Reply")').click();
    const editor = page.locator('.qr-modal');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.modal-title')).toContainText('New Quick Reply');

    await expectNoAxeViolations(page);

    // Fill in the quick reply
    await editor.locator('label:has-text("Label") + input').fill(label);
    await editor.locator('label:has-text("Script (Lua)") + textarea').fill("st.send('Hello from quick reply')");
    await editor.locator('button:has-text("Save")').click();
    await expect(editor).not.toBeVisible();

    // Verify it appears in the list
    await expect(settings.locator('.qr-settings-list')).toContainText(label);
  });

  test('deletes a global quick reply', async ({ page }) => {
    const label = uniqueName('E2E QR To Delete');

    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settings = page.locator('.settings-modal');
    await expect(settings).toBeVisible();

    await settings.locator('h3:has-text("Quick Replies")').scrollIntoViewIfNeeded();
    await settings.locator('button:has-text("Add Quick Reply")').click();
    const editor = page.locator('.qr-modal');
    await expect(editor).toBeVisible();
    await editor.locator('label:has-text("Label") + input').fill(label);
    await editor.locator('label:has-text("Script (Lua)") + textarea').fill("st.send('Delete me')");
    await editor.locator('button:has-text("Save")').click();
    await expect(editor).not.toBeVisible();
    await expect(settings.locator('.qr-settings-list')).toContainText(label);

    // Delete the quick reply
    const row = settings.locator('.qr-settings-row').filter({ hasText: label });
    await row.locator('button.btn-danger:has-text("Delete")').click();
    await expect(settings.locator('.qr-settings-list')).not.toContainText(label);
  });
});
