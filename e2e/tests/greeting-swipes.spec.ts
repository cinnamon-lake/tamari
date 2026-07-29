/**
 * Alternate-greeting swipes: the virtual greeting bubble has no swipeInfo of
 * its own, so a swipe-chrome gate on `swipeTotal > 1` used to hide its
 * arrows entirely. The bubble must show swipe arrows whenever the character
 * has multiple greetings, and they must cycle through the greetings.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';

test.describe('Alternate greeting swipes', () => {
  test('greeting bubble shows swipe arrows and cycles greetings', async ({ page }) => {
    await login(page);
    const app = new App(page);
    const charName = `Greeting Swiper ${Date.now()}`;
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character with several greetings.',
      firstMes: 'Greeting number one.',
    });

    // Attach alternate greetings over the WS bus (the editor's advanced
    // section is slow to drive; the server path is what matters here).
    await page.evaluate(
      ({ name }) =>
        new Promise<void>((resolve, reject) => {
          const token = localStorage.getItem('st_auth_token') ?? '';
          const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') {
              const char = (msg.state?.characters ?? []).find((c: { name: string }) => c.name === name);
              if (!char) { ws.close(); reject(new Error('character not found')); return; }
              ws.send(JSON.stringify({
                type: 'character.update',
                characterId: char.id,
                patch: { alternateGreetings: ['Greeting number two.', 'Greeting number three.'] },
              }));
            }
            if (msg.type === 'character.updated') { ws.close(); resolve(); }
            if (msg.type === 'error') { ws.close(); reject(new Error(msg.message)); }
          };
          setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
        }),
      { name: charName },
    );

    // Fresh chat so the greeting list (now 3 entries) is picked up.
    await app.startChat(charName);
    const bubble = page.locator('.message-bubble.assistant').last();
    await expect(bubble).toContainText('Greeting number one.');

    const left = page.locator('button[title="Swipe left"]');
    const right = page.locator('button[title="Swipe right"]');
    await expect(right).toBeVisible();
    await expect(left).toBeVisible();

    await right.click();
    await expect(bubble).toContainText('Greeting number two.');
    await expect(page.locator('.swipe-counter')).toHaveText('2/3');
    await right.click();
    await expect(bubble).toContainText('Greeting number three.');
    await expect(page.locator('.swipe-counter')).toHaveText('3/3');
    // Wraps around.
    await right.click();
    await expect(bubble).toContainText('Greeting number one.');
    await left.click();
    await expect(bubble).toContainText('Greeting number three.');
  });
});
