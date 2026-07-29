import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Character Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('creates a new character', async ({ page }) => {
    const charName = uniqueName('E2E Test Character');

    // Click "Create character" button in sidebar (it has a title attribute)
    await page.locator('[title="Create character"]').click();

    // Character editor modal opens — fill in the name and description fields
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await expectNoAxeViolations(page);

    // The first text input is the Name field
    await editor.locator('.text-input').first().fill(charName);
    // The first textarea is the Description field; the fourth is First Message
    await editor.locator('.textarea-input').nth(0).fill('A character created by e2e tests.');
    await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);

    // CharacterEditor auto-saves after 600ms of inactivity; wait for indicator
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });

    // Close the editor
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // Verify character appears in sidebar
    await expect(page.locator('.character-list')).toContainText(charName);
  });

  test('deletes a character', async ({ page }) => {
    const charName = uniqueName('Character To Delete');

    // Create a character first
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(charName);
    await editor.locator('.textarea-input').nth(0).fill('A character created by e2e tests.');
    await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    await expect(page.locator('.character-list')).toContainText(charName);

    // Open the character editor via the "Edit character" button
    const charItem = page.locator('.character-list li').filter({
      has: page.locator('.character-name', { hasText: charName }),
    });
    await charItem.locator('[title="Edit character"]').click();

    // Click Delete inside the editor
    await expect(editor).toBeVisible();
    await editor.locator('button.danger-btn', { hasText: 'Delete' }).click();

    // Confirm deletion in the popup modal
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expectNoAxeViolations(page);
    await popup.locator('button.primary, button:has-text("Delete")').click();

    // Editor and character should both be gone
    await expect(editor).not.toBeVisible();
    await expect(page.locator('.character-list')).not.toContainText(charName);
  });
});
