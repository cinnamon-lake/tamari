import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

/**
 * Dedicated a11y gate. `expectNoAxeViolations` enforces the `color-contrast`
 * rule by default (WCAG AA), so every scan here — and every scan in the feature
 * specs (backend-config, world-info, tools, prompt-list, quick-replies,
 * group-chats, chat-actions, attachments, …) — fails CI on a contrast or
 * structural regression. This file covers the chrome and the modals reachable
 * without entity setup; setup-heavy views (group panel, checkpoints, message
 * actions) are scanned by their own feature specs.
 */

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('main page has no detectable a11y violations', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('character editor modal has no a11y violations', async ({ page }) => {
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('settings modal has no a11y violations', async ({ page }) => {
    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settings = page.locator('.settings-modal');
    await expect(settings).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('persona manager modal has no a11y violations', async ({ page }) => {
    await page.locator('button.settings-btn:has-text("Personas")').click();
    const personas = page.locator('.persona-modal');
    await expect(personas).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('delete confirmation popup has a visible backdrop and no a11y violations', async ({ page }) => {
    const charName = uniqueName('A11y Delete Character');

    // Create a character
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(charName);
    await editor.locator('.textarea-input').nth(0).fill('A character created by e2e a11y tests.');
    await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // Open the editor and click Delete
    const charItem = page.locator('.character-list li').filter({
      has: page.locator('.character-name', { hasText: charName }),
    });
    await charItem.locator('[title="Edit character"]').click();
    await expect(editor).toBeVisible();
    await editor.locator('button.danger-btn', { hasText: 'Delete' }).click();

    // Confirm the popup modal appears with a backdrop
    const overlay = page.locator('.popup-backdrop, .modal-overlay');
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(overlay.first()).toBeVisible();

    // The backdrop should be visually opaque enough to separate the modal
    const overlayOpacity = await overlay.first().evaluate((el) => {
      const style = window.getComputedStyle(el);
      return Number(style.opacity);
    });
    expect(overlayOpacity).toBeGreaterThanOrEqual(0.3);

    await expectNoAxeViolations(page);

    // Confirm deletion so the test cleans up
    await popup.locator('button.primary, button:has-text("Delete")').click();
    await expect(editor).not.toBeVisible();
  });

  test('backend config modal has no a11y violations', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Backend Config")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expectNoAxeViolations(page);
  });

  test('tools modal has no a11y violations', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Tools")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const modal = page.locator('.tools-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
    // Wait for the default Lua templates to render before scanning.
    await expect(modal.locator('h3:has-text("Lua Templates")')).toBeVisible({ timeout: 5000 });
    await expectNoAxeViolations(page);
  });
});
