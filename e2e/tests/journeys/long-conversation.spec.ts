/**
 * Long conversation & pagination journey.
 *
 * The chat view paginates at `chatMessageLoadLimit` (default 30): opening a chat
 * loads only the most recent page, and a "Load more messages" button reveals
 * older turns. No other journey exercises this (deep-roleplay is ~6 messages).
 * This one builds a >30-message chat, forces a re-snapshot by re-selecting it,
 * asserts the oldest messages are paginated out, loads them back, and confirms
 * the chat still accepts new messages afterwards.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';

test.describe('Long Conversation & Pagination Journey', () => {
  test('a long chat paginates, load-more reveals older turns, and new messages still append', async ({ app, page }) => {
    const charName = `Long Char ${Date.now()}`;
    const greeting = `I am ${charName}.`;
    const turns = 16; // greeting + 16 × (user + assistant) = 33 messages, > the 30-msg page.

    await test.step('hold a long conversation past one page', async () => {
      await app.createCharacterAndChat({ name: charName, firstMes: greeting });
      for (let i = 0; i < turns; i++) {
        await app.sendUserMessage(`seq:turn ${i + 1}`, { expectReply: true });
      }
    });

    await test.step('re-select the chat so it re-snapshots to one page', async () => {
      const chatId = await app.activeChatId();
      expect(chatId).toBeTruthy();
      const total = await page.locator('.message-bubble').count();
      expect(total, 'conversation is longer than one page').toBeGreaterThan(30);

      // Clicking the active chat re-issues chat.select → snapshot limited to 30.
      await app.selectChatById(chatId as string);

      // The oldest messages are paginated out and a Load-more control is shown.
      await expect.poll(async () => await page.locator('.message-bubble').count(), {
        timeout: 10000,
        message: 'oldest messages were paginated out',
      }).toBeLessThan(total);
      await expect(page.locator('.load-more-btn')).toBeVisible();
    });

    await test.step('load more reveals the older turns (including the greeting)', async () => {
      const before = await page.locator('.message-bubble').count();
      await page.locator('.load-more-btn').click();
      // Older messages arrive; the greeting (oldest) becomes the first bubble.
      await expect(page.locator('.message-bubble').first()).toContainText(greeting, { timeout: 10000 });
      const after = await page.locator('.message-bubble').count();
      expect(after, 'older messages were appended').toBeGreaterThan(before);
    });

    await test.step('the chat still accepts new messages after paginating', async () => {
      const before = await page.locator('.message-bubble').count();
      await app.sendUserMessage('seq:one more after scrolling', { expectReply: true });
      await expect(page.locator('.message-bubble')).toHaveCount(before + 2, { timeout: 10000 });
    });
  });
});
