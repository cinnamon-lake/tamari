/**
 * Mobile keyboard scroll regression: when the visual viewport shrinks (the
 * on-screen keyboard opening), a focused field inside a bottom-sheet modal
 * must be re-scrolled into view — otherwise the sheet resizes after focus
 * and the field lands behind the keyboard (see App.tsx
 * keepFocusedFieldVisible + .modal scroll-padding-bottom).
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';

test.describe('Modal keyboard scroll', () => {
  test('focused editor field stays visible when the viewport shrinks', async ({ page }) => {
    await login(page);

    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(`Keyboard Scroll ${Date.now()}`);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });

    // Focus a textarea, then shrink the viewport as if the keyboard opened.
    const description = editor.locator('.textarea-input').nth(0);
    await description.click();
    await page.setViewportSize({ width: 390, height: 430 });

    // The field must end up fully inside the (shrunken) viewport.
    const rectOf = () =>
      description.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
    await expect.poll(async () => (await rectOf()).bottom).toBeLessThanOrEqual(430);
    const rect = await rectOf();
    expect(rect.bottom).toBeLessThanOrEqual(rect.vh);
    expect(rect.top).toBeGreaterThanOrEqual(0);
  });
});
