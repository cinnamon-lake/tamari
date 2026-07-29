/**
 * Deep roleplay journey.
 *
 * One chat that layers the prompt-injection seams a real long session hits:
 * an author's note, a keyword-triggered world-info lorebook, a streamed
 * reasoning block, a tool call, and an image attachment. World-info and
 * author's-note injection are normally invisible from the browser, so the mock
 * echoes any `[WI] TOKEN` / `[AN] TOKEN` sentinels it sees in the request back
 * in the reply — letting the journey assert the content actually reached the
 * prompt.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import { enableBuiltinToolset, deleteToolset } from '../../helpers/tools.js';

// Minimal 1x1 transparent PNG (matches attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Deep Roleplay Journey', () => {
  test('one chat layers author note, world info, reasoning, a tool call, and an attachment', async ({ app, page }) => {
    const stamp = `${Date.now()}`;
    const charName = `Deep Char ${stamp}`;
    const greeting = `I am ${charName}.`;
    const wiKey = 'skyhammer';
    const wiToken = 'SKYHAMMER_LORE';
    const anToken = 'AN_DIRECTIVE';

    let toolsetId: string | undefined;

    await test.step('create a lorebook + a character linked to it, then open a chat', async () => {
      const bookLabel = await app.createLorebook(`Lore ${stamp}`, wiKey, wiToken);
      await app.createCharacter({
        name: charName,
        description: 'Deep roleplay subject.',
        firstMes: greeting,
        lorebookBookLabel: bookLabel,
      });
      await app.startChat(charName);
    });

    await test.step('set an author note (after_prompt) and prove it injects', async () => {
      await page.locator('.chat-header button[title="Menu"]').click();
      await page.locator('.dropdown-item:has-text("Author\'s Note")').click();
      const anModal = page.locator('.modal.settings-modal').filter({ hasText: "Author's Note" });
      await expect(anModal).toBeVisible();
      // after_prompt injects on every generation regardless of message depth.
      await anModal.locator('.authors-note-position-label select').selectOption({ value: 'after_prompt' });
      await anModal.locator('.authors-note-content-input').fill(`[AN] ${anToken}`);
      // AuthorsNotePanel autosaves on a 600ms debounce; wait it out so the
      // chat.update persists before we close and generate.
      await page.waitForTimeout(800);
      await page
        .locator('.modal-overlay', { has: page.locator('.authors-note-title') })
        .click({ position: { x: 0, y: 0 } });
      await expect(anModal).not.toBeVisible();

      await app.sendUserMessage('Tell me something.');
      await app.waitForAssistantText(anToken);
    });

    await test.step('a reasoning block streams and renders', async () => {
      await app.sendUserMessage('think: walk me through your plan', { expectReply: true });
      const reasoning = app.lastBubble('assistant').locator('.reasoning-block');
      await expect(reasoning).toBeVisible({ timeout: 10000 });
      await expect(reasoning).toContainText(/thinking/i);
    });

    await test.step('enable a toolset, invoke a tool, and keep talking', async () => {
      toolsetId = await enableBuiltinToolset(page, 'lua_encouragement');
      await app.sendUserMessage('tool:encourage', { expectReply: true });
      const bubble = app.lastBubble('assistant');
      await expect(bubble.locator('.tool-call-block').first()).toBeVisible({ timeout: 10000 });
      const result = bubble.locator('.tool-result-block').first();
      await expect(result).toBeVisible({ timeout: 10000 });
      await expect(result).not.toBeEmpty();

      // A normal turn still works after the tool round.
      await app.sendUserMessage('seq:carry on', { expectReply: true });
      await app.waitForAssistantText(/inject:|Turn \d+/);
    });

    await test.step('world info triggers on the keyword and injects', async () => {
      await app.sendUserMessage(`Tell me about the ${wiKey}.`);
      await app.waitForAssistantText(wiToken);
    });

    await test.step('attach an image and send it with a message', async () => {
      const fileInput = page.locator('.message-input-area .hidden-file-input');
      await fileInput.setInputFiles({
        name: 'pic.png',
        mimeType: 'image/png',
        buffer: Buffer.from(PNG_BASE64, 'base64'),
      });
      await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

      await app.sendUserMessage('Here is a picture.');
      const userBubble = app.lastBubble('user');
      await expect(userBubble.locator('.message-attachments')).toBeVisible();
      await expect(userBubble.locator('.message-attachment-img')).toBeVisible();
    });

    if (toolsetId) await deleteToolset(page, toolsetId);
  });
});
