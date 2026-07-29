/**
 * Tools & quick replies journey.
 *
 * Exercises a built-in toolset end-to-end (invoke a tool, render the call +
 * result blocks, keep talking) and the quick-reply system end-to-end (create a
 * global QR from Settings, fire it from the bar, then create a character-scoped
 * QR from inside a chat and prove it only appears for that character while
 * globals still appear everywhere).
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import { enableBuiltinToolset, deleteToolset } from '../../helpers/tools.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../../helpers/llm.js';
import type { Page } from '@playwright/test';

async function createGlobalQuickReply(page: Page, label: string, script: string): Promise<void> {
  await page.locator('button.settings-btn:has-text("Settings")').click();
  const settings = page.locator('.settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator('h3:has-text("Quick Replies")').scrollIntoViewIfNeeded();
  await settings.locator('button:has-text("Add Quick Reply")').click();
  const editor = page.locator('.qr-modal');
  await expect(editor).toBeVisible();
  await editor.locator('label:has-text("Label") + input').fill(label);
  await editor.locator('label:has-text("Script (Lua)") + textarea').fill(script);
  await editor.locator('button:has-text("Save")').click();
  await expect(editor).not.toBeVisible();
  await settings.locator('button.btn:has-text("Close")').click();
  await expect(settings).not.toBeVisible();
}

async function clickQuickReply(page: Page, label: string): Promise<void> {
  const btn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
  await expect(btn).toBeVisible();
  await btn.click();
}

test.describe('Tools & Quick Replies Journey', () => {
  test('tools render and persist; quick replies run and respect scope', async ({ app, page }) => {
    const stamp = `${Date.now()}`;
    const globalLabel = `Global QR ${stamp}`;
    let toolsetId: string | undefined;
    let diceToolsetId: string | undefined;

    await test.step('invoke multiple tools in sequence mid-conversation', async () => {
      toolsetId = await enableBuiltinToolset(page, 'lua_encouragement');
      diceToolsetId = await enableBuiltinToolset(page, 'lua_dice');
      await app.createCharacterAndChat({ name: `Tool Char ${stamp}`, firstMes: 'I am ready.' });

      // A normal turn first — tools must work mid-conversation, not just on a fresh chat.
      await app.sendUserMessage('seq:hello', { expectReply: true });
      await app.waitForAssistantText(/Turn \d+/);

      // The tool turn: the mock walks the sequence roll_dice → encourage → answer.
      const before = (await getLastLlmRequest()).count;
      await app.sendUserMessage('tool:roll_dice,encourage', { expectReply: true });
      // The loop must iterate the full sequence: 2 tool rounds + the final
      // answer = 3 LLM calls. If the multi-round machinery regresses (stops
      // after one result, or loops forever), this wait or the block counts fail.
      await waitForNextLlmRequest(before + 2);

      const bubble = app.lastBubble('assistant');
      // roll_dice's result carries extra.renderType='dice', so by design its
      // tool-call block is suppressed and the hydrated dice widget represents
      // the call (see DisplayRenderer's widgetToolUseIds pre-scan). Only
      // encourage renders a generic call block, while both results render as
      // .tool-result-block (the dice widget is one too).
      await expect(bubble.locator('.tool-call-block')).toHaveCount(1, { timeout: 10000 });
      await expect(bubble.locator('.dice-result')).toHaveCount(1);
      await expect(bubble.locator('.tool-result-block')).toHaveCount(2, { timeout: 10000 });
      // …and the sequence terminates in a plain-text answer, not another call.
      await app.waitForAssistantText(/deterministic mock response/);

      // The session is healthy after the loop: a normal turn still generates.
      await app.sendUserMessage('seq:still alive', { expectReply: true });
      await app.waitForAssistantText(/Turn \d+/);
    });

    await test.step('a global quick reply runs from the bar', async () => {
      await createGlobalQuickReply(page, globalLabel, 'st.send("Fired by global QR")');
      await clickQuickReply(page, globalLabel);
      await expect(page.locator('.message-bubble.user', { hasText: 'Fired by global QR' })).toBeVisible({
        timeout: 5000,
      });
    });

    await test.step('a character-scoped quick reply only shows for that character', async () => {
      const charA = `QR Char A ${stamp}`;
      const charB = `QR Char B ${stamp}`;
      const charLabel = `CharA Only ${stamp}`;

      await app.createCharacterAndChat({ name: charA, firstMes: `I am ${charA}.` });
      // Open the editor from the bar so the 'character' scope option is present.
      await page.locator('.quick-reply-btn.quick-reply-add').click();
      const editor = page.locator('.qr-modal');
      await expect(editor).toBeVisible();
      await editor.locator('#qr-scope').selectOption({ value: 'character' });
      await editor.locator('label:has-text("Label") + input').fill(charLabel);
      await editor.locator('label:has-text("Script (Lua)") + textarea').fill('st.send("charA scoped")');
      await editor.locator('button:has-text("Save")').click();
      await expect(editor).not.toBeVisible();

      // Visible in charA's bar, and runs.
      await expect(page.locator('.quick-reply-bar .quick-reply-btn', { hasText: charLabel })).toBeVisible({
        timeout: 5000,
      });
      await clickQuickReply(page, charLabel);
      await expect(page.locator('.message-bubble.user', { hasText: 'charA scoped' })).toBeVisible({
        timeout: 5000,
      });

      // Switch to a different character: the charA-scoped QR must vanish, but
      // the global QR is still here.
      await app.createCharacterAndChat({ name: charB, firstMes: `I am ${charB}.` });
      await expect(page.locator('.quick-reply-bar')).toBeVisible();
      await expect(page.locator('.quick-reply-bar .quick-reply-btn', { hasText: charLabel })).toHaveCount(0);
      await expect(page.locator('.quick-reply-bar .quick-reply-btn', { hasText: globalLabel })).toBeVisible();
    });

    if (toolsetId) await deleteToolset(page, toolsetId);
    if (diceToolsetId) await deleteToolset(page, diceToolsetId);
  });
});
