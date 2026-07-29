import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

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
  // With a configured backend, generation adds an assistant reply as well.
  // Wait until the user message is present instead of asserting an exact count.
  const msg = page.locator('.message-bubble.user').last();
  await expect(msg).toContainText(text, { timeout: 5000 });
  return msg;
}

test.describe('Generation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('generates an assistant reply via the mock backend', async ({ page }) => {
    const charName = uniqueName('Generation Character');
    await createCharacterAndChat(page, charName);

    await sendUserMessage(page, 'Hello!');

    const assistantBubble = page.locator('.message-bubble.assistant').last();
    await expect(assistantBubble).toContainText('Hello! This is a deterministic mock response', {
      timeout: 10000,
    });

    await expectNoAxeViolations(page);
  });

  test('regenerates the last assistant message', async ({ page }) => {
    const charName = uniqueName('Regenerate Character');
    await createCharacterAndChat(page, charName);

    await sendUserMessage(page, 'First message');
    const assistantBubble = page.locator('.message-bubble.assistant').last();
    await expect(assistantBubble).toContainText('Hello! This is a deterministic mock response', {
      timeout: 10000,
    });

    // Force message action buttons visible and click regenerate.
    await page.addStyleTag({ content: '.message-actions { opacity: 1 !important; transform: none !important; }' });
    await assistantBubble.locator('button[title="Regenerate"]').evaluate((el: HTMLButtonElement) => el.click());

    // After regeneration the assistant bubble should still contain the deterministic text.
    await expect(page.locator('.message-bubble.assistant').last()).toContainText(
      'Hello! This is a deterministic mock response',
      { timeout: 10000 },
    );

    await expectNoAxeViolations(page);
  });
});
