/**
 * Multi-client + persistence journey.
 *
 * The architecture's three headline claims are that the server is the single
 * source of truth, that mutations broadcast to every connected client, and that
 * state persists — yet no browser test exercised any of them. This journey does
 * all three in one session:
 *
 *   - Client A creates a character/chat and sends a message.
 *   - Client B (a separate browser context, logged into the same server) is
 *     viewing the chat and sees A's message appear live over the broadcast.
 *   - Client B is discarded; a brand-new Client C logs in from scratch and the
 *     whole conversation is restored purely from server state.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import { login } from '../../helpers/auth.js';

test.describe('Multi-Client & Persistence Journey', () => {
  test('two clients stay in sync; a fresh session restores everything from the server', async ({ app, page, browser }) => {
    const charName = `Sync Char ${Date.now()}`;
    const greeting = `Hello from ${charName}.`;
    const liveMessage = 'seq:Can the other tab hear me?';

    // Client B is logged in up front so it is already watching when A acts.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await login(pageB);

    await test.step('client A creates a character and opens a chat', async () => {
      await app.createCharacter({ name: charName, description: 'For multi-client sync.', firstMes: greeting });
      await app.startChat(charName);
    });

    await test.step('client B opens the same chat and sees the greeting', async () => {
      await expect(pageB.locator('.chat-list')).toContainText(charName, { timeout: 10000 });
      await pageB.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first().click();
      await expect(pageB.locator('.chat-view')).toBeVisible();
      await expect(pageB.locator('.message-bubble.assistant').first()).toContainText(greeting, { timeout: 10000 });
    });

    await test.step('client A sends a message; client B sees it arrive live', async () => {
      await app.sendUserMessage(liveMessage, { expectReply: true });
      // B is viewing the chat and receives the broadcast — no re-select needed.
      await expect(pageB.locator('.message-bubble.user').last()).toContainText('Can the other tab hear me', {
        timeout: 10000,
      });
    });

    await test.step('a brand-new session restores the whole conversation from the server', async () => {
      await ctxB.close();

      const ctxC = await browser.newContext();
      const pageC = await ctxC.newPage();
      await login(pageC);

      // Fresh login → server snapshot repopulates everything.
      await expect(pageC.locator('.chat-list')).toContainText(charName, { timeout: 10000 });
      await pageC.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first().click();
      await expect(pageC.locator('.chat-view')).toBeVisible();
      await expect(pageC.locator('.message-bubble.assistant').first()).toContainText(greeting);
      await expect(pageC.locator('.message-bubble.user').last()).toContainText('Can the other tab hear me');

      await ctxC.close();
    });
  });
});
