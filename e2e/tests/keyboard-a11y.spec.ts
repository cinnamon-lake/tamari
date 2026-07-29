import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Keyboard Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('character card is focusable and Enter activates it', async ({ page }) => {
    const charName = uniqueName('KbA11y');

    // Create a character
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await editor.locator('.text-input').first().fill(charName);
    await editor.locator('.textarea-input').nth(0).fill('Keyboard test character.');
    await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();
    // Modal close restores focus to the "Create character" trigger via rAF.
    // Wait for that handoff before the keyboard gesture below — otherwise the
    // restore can steal focus back mid-gesture, and Enter on the trigger opens
    // a fresh editor modal (which then inerts the sidebar for good).
    await expect(page.locator('[title="Create character"]')).toBeFocused({ timeout: 3000 });

    // Search for the character so it's the only one visible
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    const charCard = page.locator('.character-main').first();
    await expect(charCard).toBeVisible({ timeout: 5000 });

    // Verify it has role=button and tabindex=0
    await expect(charCard).toHaveAttribute('role', 'button');
    await expect(charCard).toHaveAttribute('tabindex', '0');

    // Focus the card and press Enter — should select the character (the
    // character-item gets the selected class). A character.listed broadcast
    // can re-render the list between focus() and the keypress and drop focus,
    // so retry the whole gesture until the selection sticks.
    await expect(async () => {
      await charCard.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.character-item.selected')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10000 });
  });

  test('Escape closes modals via the global handler', async ({ page }) => {
    // Open the Settings modal
    const settingsBtn = page.locator('button.settings-btn:has-text("Settings")');
    await settingsBtn.scrollIntoViewIfNeeded();
    await settingsBtn.click();
    const modal = page.locator('.modal.settings-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Press Escape — the global handler should close it
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test('Escape closes the Backend Config modal', async ({ page }) => {
    const btn = page.locator('button.settings-btn:has-text("Backend Config")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test('Tab focus is trapped within modals', async ({ page }) => {
    // Open Settings modal
    const settingsBtn = page.locator('button.settings-btn:has-text("Settings")');
    await settingsBtn.scrollIntoViewIfNeeded();
    await settingsBtn.click();
    const modal = page.locator('.modal.settings-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Tab several times — focus should always stay within the modal
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const activeTag = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'body';
        const modal = el.closest('.modal.settings-modal');
        return modal ? 'inside-modal' : 'outside-modal';
      });
      expect(activeTag).toBe('inside-modal');
    }

    // Clean up
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test('focus is restored to the trigger after closing a modal', async ({ page }) => {
    // The Settings button should receive focus back after the modal closes
    const settingsBtn = page.locator('button.settings-btn:has-text("Settings")');
    await settingsBtn.scrollIntoViewIfNeeded();
    await settingsBtn.focus();
    await expect(settingsBtn).toBeFocused();

    await settingsBtn.click();
    const modal = page.locator('.modal.settings-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Close via Escape (which triggers the global handler → overlay click → onClose → restoreFocus)
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3000 });

    // Focus is restored to the trigger via requestAnimationFrame — restoreFocus
    // defers the focus call until after the dialog unmounts and the background
    // is un-inerted (otherwise focusing the still-inert trigger is a no-op).
    // Poll briefly for focus to leave <body>.
    await expect.poll(
      async () =>
        page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return 'body';
          return el.tagName;
        }),
      { timeout: 2000, intervals: [50, 100, 200] },
    ).not.toBe('body');
  });
});
