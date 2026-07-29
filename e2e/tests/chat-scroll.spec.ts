/**
 * Chat scrolling regression: the message list (`.virtual-list.messages`) must
 * actually scroll. A stray `.messages { overflow: hidden }` rule once
 * overrode `.virtual-list`'s `overflow: auto` (same specificity, later in
 * ChatView.css) and killed scrolling entirely — these assertions lock in the
 * scroller's overflow, manual scroll, and the scroll-to-bottom affordance.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

test.describe('Chat scrolling', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('message list scrolls, pins to bottom on new replies, and scroll-to-bottom works', async ({ page }) => {
    // Short viewport so a handful of exchanges overflow the list.
    await page.setViewportSize({ width: 1280, height: 500 });
    const app = new App(page);
    const charName = `Scroll Tester ${Date.now()}`;
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character for scroll testing.',
      firstMes: 'Greetings, traveler.',
    });

    const scroller = page.locator('.virtual-list.messages');

    for (let i = 0; i < 6; i++) {
      await app.sendUserMessage(`scroll test message ${i}`, { expectReply: true });
    }

    // The scroller itself must carry overflow:auto (not be clipped by the
    // `.messages` rule) and the content must actually overflow it.
    const metrics = await scroller.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        overflowY: cs.overflowY,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
      };
    });
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 100);

    // Auto-scroll pinned the view to the bottom after the last reply.
    expect(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight).toBeLessThan(60);

    // Scrolling up sticks and reveals the scroll-to-bottom button.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(scroller).toHaveJSProperty('scrollTop', 0);
    const toBottom = page.locator('.scroll-to-bottom-btn');
    await expect(toBottom).toBeVisible();

    // Clicking it returns to the bottom. Re-click inside the poll: under
    // full-suite load a single click can be swallowed (the button ends up
    // focused but no click handler fires), leaving the scroller pinned at the
    // top forever — the click is idempotent, so retrying it is safe, while a
    // genuinely broken button still fails the poll.
    await expect
      .poll(async () => {
        if (await toBottom.isVisible()) {
          await toBottom.click({ timeout: 1000 }).catch(() => {});
        }
        return scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      })
      .toBeLessThan(60);
  });
});
