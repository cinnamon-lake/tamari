import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('World Info', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('creates and edits a lorebook', async ({ page }) => {
    const bookName = uniqueName('E2E Lorebook');

    const btn = page.locator('button.settings-btn:has-text("World Info")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();

    const editor = page.locator('.worldinfo-modal');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.modal-title')).toContainText('World Info');

    await expectNoAxeViolations(page);

    await editor.locator('button:has-text("New Lorebook")').click();
    const newBook = editor.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first();
    await expect(newBook).toBeVisible();
    await newBook.click();
    await expect(editor.locator('.book-editor')).toBeVisible();

    const nameInput = editor.locator('.book-name-input');
    await nameInput.fill(bookName);
    await nameInput.blur();

    // Add a new entry, then click the entry row to enter edit mode
    await editor.locator('button:has-text("Add Entry")').click();
    const newEntry = editor.locator('.entry-row').first();
    await expect(newEntry).toBeVisible();
    await newEntry.click();
    await expect(editor.locator('.entry-editor')).toBeVisible();

    const keysInput = editor.locator('.entry-editor label:has-text("Keys") input');
    await keysInput.fill('magic, spell');
    await keysInput.blur();

    const contentInput = editor.locator('.entry-editor label:has-text("Content") textarea');
    await contentInput.fill('A powerful arcane effect.');
    await contentInput.blur();

    // Go back and verify the lorebook is listed
    await editor.locator('button.back-btn:has-text("Back")').click();
    await expect(editor.locator('.worldinfo-list')).toContainText(bookName);

    // Close the modal
    await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
    await expect(editor).not.toBeVisible();
  });
});
