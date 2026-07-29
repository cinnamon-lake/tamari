import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function createCharacterAndChat(page: any, charName: string) {
  await page.locator('[title="Create character"]').click();
  const editor = page.locator('.character-editor-modal');
  await expect(editor).toBeVisible();
  await editor.locator('.text-input').first().fill(charName);
  await editor.locator('.textarea-input').nth(0).fill('A character created by e2e tests.');
  await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
  await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
  await editor.locator('[title="Close"]').click();
  await expect(editor).not.toBeVisible();

  await page.locator('input[placeholder="Search characters..."]').fill(charName);
  const charRow = page.locator('.character-list li').filter({
    has: page.locator('.character-name', { hasText: charName }),
  });
  await charRow.waitFor({ state: 'visible' });
  await page.addStyleTag({ content: '.character-list .character-actions { opacity: 1 !important; }' });
  const newChatBtn = charRow.locator('[title="New chat"]');
  await newChatBtn.waitFor({ state: 'visible' });
  await newChatBtn.click({ force: true });

  const chatItem = page.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first();
  await expect(chatItem).toBeVisible({ timeout: 10000 });
  await chatItem.click();

  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });
}

async function sendUserMessage(page: any, text: string) {
  const input = page.locator('.message-textarea');
  await input.fill(text);
  await page.locator('.message-input-area .send-btn').click();
  await expect(input).toHaveValue('');
  const msg = page.locator('.message-bubble.user').last();
  await expect(msg).toContainText(text, { timeout: 5000 });
  return msg;
}

test.describe('Generation Tools', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('executes a built-in tool and renders the result', async ({ page }) => {
    const charName = uniqueName('Tool Character');

    toolsetId = await enableBuiltinToolset(page, 'lua_encouragement');
    await createCharacterAndChat(page, charName);

    await sendUserMessage(page, 'tool:encourage');

    const assistantBubble = page.locator('.message-bubble.assistant').last();
    await expect(assistantBubble).toContainText('encourage', { timeout: 10000 });
    await expect(assistantBubble).toContainText('Result', { timeout: 10000 });

    // The message should render the tool call and its executed result.
    await expect(assistantBubble.locator('.tool-call-block').first()).toBeVisible({ timeout: 10000 });
    const resultBlock = assistantBubble.locator('.tool-result-block').first();
    await expect(resultBlock).toBeVisible({ timeout: 10000 });
    await expect(resultBlock).not.toBeEmpty();

    await expectNoAxeViolations(page);
  });

  test('executes multiple tools in sequence before answering', async ({ page }) => {
    const app = new App(page);
    const diceId = await enableBuiltinToolset(page, 'lua_dice');
    const encourageId = await enableBuiltinToolset(page, 'lua_encouragement');
    try {
      await app.createCharacterAndChat({ name: uniqueName('MultiTool Char'), firstMes: 'Ready.' });

      // The mock walks the sequence: round 1 calls roll_dice, round 2 (after
      // seeing its result) calls encourage, round 3 answers with plain text.
      await app.sendUserMessage('tool:roll_dice,encourage', { expectReply: true });

      const bubble = app.lastBubble('assistant');
      // roll_dice has a renderType ("dice"): its tool_use block is suppressed and
      // its result renders as the dice widget. encourage is a plain tool: one
      // tool-call block and one generic result block.
      await expect(bubble.locator('.tool-call-block')).toHaveCount(1, { timeout: 10000 });
      await expect(bubble.locator('.dice-result')).toBeVisible();
      await expect(bubble.locator('.tool-result-block')).toHaveCount(2);
      // The sequence terminates with a plain-text answer (the mock default).
      expect(await app.lastAssistantText()).toContain('deterministic mock response');
    } finally {
      await deleteToolset(page, diceId);
      await deleteToolset(page, encourageId);
    }
  });
});
