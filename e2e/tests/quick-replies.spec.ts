import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';
import { createLuaQuickReply, deleteLuaQuickReply } from '../helpers/quickReplies.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Quick Replies', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('creates a global quick reply', async ({ page }) => {
    const app = new App(page);
    const label = uniqueName('E2E QR');

    // The quick reply bar (and its `+` add button) only exists in a chat view.
    await app.createCharacterAndChat({
      name: uniqueName('QR Create Char'),
      firstMes: 'Ready.',
    });

    // Open the quick reply editor from the bar.
    await page.locator('.quick-reply-bar .quick-reply-add').click();
    const editor = page.locator('.qr-modal');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.modal-title')).toContainText('New Quick Reply');

    await expectNoAxeViolations(page);

    // Fill in the quick reply (the scope select defaults to Global).
    await editor.locator('#qr-label').fill(label);
    await editor.locator('#qr-script').fill("st.send('Hello from quick reply')");
    await editor.locator('button.btn-primary:has-text("Save")').click();
    await expect(editor).not.toBeVisible();

    // Verify it appears in the bar.
    await expect(
      page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label }),
    ).toBeVisible();

    // Cleanup so the global reply can't leak into other specs.
    await deleteLuaQuickReply(page, label);
  });

  test('deletes a global quick reply', async ({ page }) => {
    const app = new App(page);
    const label = uniqueName('E2E QR To Delete');

    await app.createCharacterAndChat({
      name: uniqueName('QR Delete Char'),
      firstMes: 'Ready.',
    });

    await createLuaQuickReply(page, label, "st.send('Delete me')");
    const qrBtn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
    await expect(qrBtn).toBeVisible();

    // Right-click the bar button to open the editor in edit mode, then delete.
    await qrBtn.click({ button: 'right' });
    const editor = page.locator('.qr-modal');
    await expect(editor).toBeVisible();
    await editor.locator('button.btn-danger:has-text("Delete")').click();
    await expect(editor).not.toBeVisible();
    await expect(qrBtn).toHaveCount(0);
  });
});
