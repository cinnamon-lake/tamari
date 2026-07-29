import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function createCharacterAndChat(page: import('@playwright/test').Page, charName: string) {
  await page.locator('[title="Create character"]').click();
  const editor = page.locator('.character-editor-modal');
  await expect(editor).toBeVisible();
  await editor.locator('.text-input').first().fill(charName);
  await editor.locator('.textarea-input').nth(0).fill('A character for swipe picker tests.');
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
  await charRow.locator('[title="New chat"]').click({ force: true });

  const chatItem = page.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first();
  await expect(chatItem).toBeVisible({ timeout: 10000 });
  await chatItem.click();

  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });
}

async function sendUserMessage(page: import('@playwright/test').Page, text: string) {
  const input = page.locator('.message-textarea');
  await input.fill(text);
  await page.locator('.message-input-area .send-btn').click();
  await expect(input).toHaveValue('');
  const msg = page.locator('.message-bubble.user').last();
  await expect(msg).toContainText(text, { timeout: 5000 });
  return msg;
}

async function waitForAssistantReply(page: import('@playwright/test').Page, text: string, timeout = 10000) {
  const bubble = page.locator('.message-bubble.assistant').last();
  await expect(bubble.locator('.message-content')).toContainText(text, { timeout });
}

test.describe('Swipe Picker', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('opens the swipe picker popup and jumps to a specific swipe', async ({ page }) => {
    const charName = uniqueName('SwipePicker');
    await createCharacterAndChat(page, charName);

    // Send a message with the mock's "respond:" prefix so the first reply is predictable.
    await sendUserMessage(page, 'respond: First swipe text');
    await waitForAssistantReply(page, 'First swipe text');

    // Regenerate to create a second swipe (also uses "respond:" so it's distinct).
    await page.addStyleTag({ content: '.message-actions { opacity: 1 !important; transform: none !important; }' });
    const assistantBubble = page.locator('.message-bubble.assistant').last();
    await assistantBubble.locator('button[title="Regenerate"]').evaluate((el: HTMLButtonElement) => el.click());

    // Wait for the regenerate to settle — the mock returns the default deterministic text.
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 15000 });

    // The swipe counter should show 1/2 or 2/2.
    const counter = page.locator('.swipe-counter');
    await expect(counter).toBeVisible({ timeout: 5000 });

    // Click the counter to open the swipe picker popup.
    await counter.click();
    const picker = page.locator('.swipe-picker-modal');
    await expect(picker).toBeVisible({ timeout: 5000 });

    // The picker should list 2 rows.
    const rows = picker.locator('.swipe-picker-row');
    await expect(rows).toHaveCount(2, { timeout: 5000 });

    // One row should be marked active.
    await expect(picker.locator('.swipe-picker-row.active')).toHaveCount(1);

    // Click the non-active row to jump to the other swipe.
    const inactiveRow = picker.locator('.swipe-picker-row:not(.active)').first();
    await inactiveRow.click();

    // The popup should close.
    await expect(picker).not.toBeVisible({ timeout: 3000 });

    // The counter should still show 2 swipes.
    await expect(page.locator('.swipe-counter')).toContainText('/2');
  });

  test('shows content previews in the swipe picker', async ({ page }) => {
    const charName = uniqueName('SwipePreview');
    await createCharacterAndChat(page, charName);

    await sendUserMessage(page, 'respond: Alpha swipe');
    await waitForAssistantReply(page, 'Alpha swipe');

    await page.addStyleTag({ content: '.message-actions { opacity: 1 !important; transform: none !important; }' });
    const assistantBubble = page.locator('.message-bubble.assistant').last();
    await assistantBubble.locator('button[title="Regenerate"]').evaluate((el: HTMLButtonElement) => el.click());
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 15000 });

    await page.locator('.swipe-counter').click();
    const picker = page.locator('.swipe-picker-modal');
    await expect(picker).toBeVisible({ timeout: 5000 });

    // The active row's preview should contain "Alpha" (the first swipe's text).
    const activePreview = picker.locator('.swipe-picker-row.active .swipe-picker-preview');
    await expect(activePreview).toContainText('Alpha', { timeout: 5000 });

    // Close the picker.
    await page.locator('.modal-overlay').click({ position: { x: 0, y: 0 } });
    await expect(picker).not.toBeVisible({ timeout: 3000 });
  });
});
