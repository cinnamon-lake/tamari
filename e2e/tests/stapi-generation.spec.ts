import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function createGlobalQuickReply(page: any, label: string, script: string) {
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

async function clickQuickReply(page: any, label: string) {
  const qrBtn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
  await expect(qrBtn).toBeVisible();
  await qrBtn.click();
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

test.describe.configure({ mode: 'serial' });

test.describe('StApi Generation Integration', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('st.add_swipe adds a swipe to the active assistant message', async ({ page }) => {
    const label = uniqueName('StApi Add Swipe');
    const charName = uniqueName('StApi Add Swipe Character');

    await createGlobalQuickReply(page, label, 'st.add_swipe("Swiped via StApi", true)');
    await createCharacterAndChat(page, charName);

    // Use the mock server's respond-prefix so the initial swipe text is predictable.
    await sendUserMessage(page, 'respond: First assistant response');

    const assistantBubble = page.locator('.message-bubble.assistant').last();
    await expect(assistantBubble).toContainText('First assistant response', { timeout: 10000 });

    await clickQuickReply(page, label);

    // After switching to the new swipe, the assistant text should change and the swipe counter should show 2/2.
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('Swiped via StApi', {
      timeout: 5000,
    });
    await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 5000 });

    await expectNoAxeViolations(page);
  });
});
