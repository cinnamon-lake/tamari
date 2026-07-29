/**
 * Mobile message-edit regression: with the on-screen keyboard open (shrunken
 * viewport), the inline message editor must stay usable — the edit container
 * (textarea + Save/Cancel actions) has to fit inside the chat list's visible
 * scrollport, and the floating scroll-to-bottom button must not cover the
 * actions. Guards the compact-composer (max-height media query), the edit
 * textarea caps, and the visualViewport re-pin in App.tsx.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

test.describe('Mobile message editing', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('edit box and actions stay visible with the keyboard open', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const app = new App(page);
    // Mobile layout: the sidebar lives behind the hamburger drawer.
    await page.locator('.mobile-menu-btn').click();
    const charName = `Mobile Edit ${Date.now()}`;
    await app.createCharacter({ name: charName, description: 'A character for mobile edit testing.', firstMes: 'Greetings, traveler.' });

    // app.startChat's explicit chat-item click doesn't survive the mobile
    // drawer auto-closing — the client already selects the new chat, so just
    // open it and wait for the greeting bubble. No force: the natural
    // actionability checks wait for the drawer's slide-in to settle.
    await app.revealHoverButtons();
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    await app.characterRow(charName).locator('[title="New chat"]').click();
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });

    for (let i = 0; i < 3; i++) {
      await app.sendUserMessage(`mobile edit test message ${i}`, { expectReply: true });
    }

    // Open the inline editor on the first user message and make the text long
    // enough to hit the edit-area height caps.
    const target = page.locator('.message-bubble.user').first();
    await app.clickMessageAction(target, 'Edit');
    const editTa = page.locator('.edit-textarea');
    await expect(editTa).toBeVisible();
    await editTa.fill('Line of text to make this message tall. '.repeat(60));

    // The on-screen keyboard opens: the viewport shrinks.
    await page.setViewportSize({ width: 390, height: 430 });

    // The whole edit container — Save/Cancel included — must be inside the
    // chat list's visible scrollport, not clipped behind the composer.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const actions = document.querySelector('.edit-actions')?.getBoundingClientRect();
          const list = document.querySelector('.virtual-list.messages')?.getBoundingClientRect();
          return actions && list ? list.bottom - actions.bottom : -Infinity;
        }),
      )
      .toBeGreaterThanOrEqual(0);

    // The floating scroll-to-bottom button must not cover the actions.
    await expect(page.locator('.scroll-to-bottom-btn')).toBeHidden();

    // Typing keeps everything in place (no scroll-to-top jump).
    const before = await page.evaluate(
      () => document.querySelector('.virtual-list.messages')?.scrollTop ?? -1,
    );
    await page.keyboard.type(' more text', { delay: 20 });
    const after = await page.evaluate(
      () => document.querySelector('.virtual-list.messages')?.scrollTop ?? -1,
    );
    expect(Math.abs(after - before)).toBeLessThan(80);
  });
});
