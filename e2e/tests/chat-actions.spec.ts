import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
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

  // Filter the character list so the target row is always reachable regardless of pagination.
  await page.locator('input[placeholder="Search characters..."]').fill(charName);

  const charRow = page.locator('.character-list li').filter({
    has: page.locator('.character-name', { hasText: charName }),
  });
  await charRow.waitFor({ state: 'visible' });
  // Action buttons are opacity-0 until hover; force them visible for automation.
  await page.addStyleTag({ content: '.character-list .character-actions { opacity: 1 !important; }' });
  const newChatBtn = charRow.locator('[title="New chat"]');
  await newChatBtn.waitFor({ state: 'visible' });
  await newChatBtn.click({ force: true });

  // The client auto-selects new chats, but explicit selection is more reliable under load.
  const chatItem = page.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first();
  await expect(chatItem).toBeVisible({ timeout: 10000 });
  await chatItem.click();

  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });
}

async function sendUserMessage(page: any, text: string) {
  const input = page.locator('.message-textarea');
  const beforeCount = await page.locator('.message-bubble').count();
  await input.fill(text);
  await page.locator('.message-input-area .send-btn').click();
  await expect(input).toHaveValue('');
  // Wait for the new user message to appear.
  await expect(page.locator('.message-bubble')).toHaveCount(beforeCount + 1, { timeout: 5000 });
  const msg = page.locator('.message-bubble.user').last();
  await expect(msg).toContainText(text, { timeout: 5000 });
  return msg;
}

async function clickMessageAction(page: any, message: any, title: string) {
  // Action buttons are only visible on hover in the desktop layout.
  // Inject a style rule to keep them visible for reliable interaction.
  await page.addStyleTag({ content: '.message-actions { opacity: 1 !important; transform: none !important; }' });
  const btn = message.locator(`button[title="${title}"]`);
  await btn.evaluate((el: HTMLButtonElement) => el.click());
}

test.describe('Chat Actions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('renames a chat from the sidebar', async ({ page }) => {
    const charName = uniqueName('Rename Chat Character');
    const newChatName = uniqueName('Renamed Chat');
    await createCharacterAndChat(page, charName);

    // Find the chat in the sidebar and click rename
    const chatItem = page.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first();
    await chatItem.scrollIntoViewIfNeeded();
    await page.addStyleTag({ content: '.chat-actions { opacity: 1 !important; }' });
    await chatItem.locator('[title="Rename"]').evaluate((el: HTMLButtonElement) => el.click());

    // Re-query the rename input after the chat item re-renders.
    const renameInput = page.locator('.chat-rename-input');
    await renameInput.fill(newChatName);
    await renameInput.press('Enter');

    // Verify the chat name updated
    await expect(page.locator('.chat-list')).toContainText(newChatName);
  });

  test('deletes the active chat from the header menu', async ({ page }) => {
    const charName = uniqueName('Delete Chat Character');
    await createCharacterAndChat(page, charName);

    // Open the header menu and delete the chat
    await page.locator('.chat-header button[title="Menu"]').click();
    await page.locator('.dropdown-item:has-text("Delete chat")').click();

    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary, button:has-text("Delete")').click();

    // Verify the chat is removed from the sidebar
    await expect(page.locator('.chat-list')).not.toContainText(charName);
  });

  test('edits a message', async ({ page }) => {
    const charName = uniqueName('Edit Message Character');
    await createCharacterAndChat(page, charName);
    const msg = await sendUserMessage(page, 'Hello from edit test!');

    await clickMessageAction(page, msg, 'Edit');

    // Re-query the editing textarea after the bubble re-renders.
    const textarea = page.locator('.message-bubble.editing .edit-textarea');
    await textarea.fill('Edited message from e2e tests!');
    await page.locator('.message-bubble.editing button:has-text("Save")').click();

    await expect(page.locator('.message-bubble.user').last().locator('.message-content')).toContainText(
      'Edited message from e2e tests!',
    );
    await expectNoAxeViolations(page);
  });

  test('hides and unhides a message', async ({ page }) => {
    const charName = uniqueName('Hide Message Character');
    await createCharacterAndChat(page, charName);

    // Hidden messages are filtered from the chat view unless this setting is on.
    await page.locator('button.settings-btn:has-text("Settings")').click();
    const settingsModal = page.locator('.settings-modal').filter({ hasText: 'Settings' });
    await expect(settingsModal).toBeVisible();
    const showHidden = settingsModal.locator('label:has-text("Show hidden messages") input[type="checkbox"]');
    await showHidden.evaluate((el: HTMLInputElement) => {
      if (!el.checked) el.click();
    });
    await settingsModal.locator('button.btn:has-text("Close")').click();
    await expect(settingsModal).not.toBeVisible();

    const msg = await sendUserMessage(page, 'Hello from hide test!');

    await clickMessageAction(page, msg, 'Hide');
    await expect(page.locator('.message-bubble.user.hidden-message').last()).toBeVisible({ timeout: 5000 });

    await clickMessageAction(page, page.locator('.message-bubble.user').last(), 'Unhide');
    await expect(page.locator('.message-bubble.user.hidden-message')).toHaveCount(0);

    // Restore the global showHiddenMessages setting — leaving it on keeps
    // hidden messages visible for every later spec on the shared server
    // (e.g. stapi-chat-actions' st.hide test counts visible bubbles).
    await page.locator('button.settings-btn:has-text("Settings")').click();
    await expect(settingsModal).toBeVisible();
    await showHidden.evaluate((el: HTMLInputElement) => {
      if (el.checked) el.click();
    });
    await settingsModal.locator('button.btn:has-text("Close")').click();
    await expect(settingsModal).not.toBeVisible();
  });

  test('forks a message into a new chat', async ({ page }) => {
    const charName = uniqueName('Fork Message Character');
    await createCharacterAndChat(page, charName);
    const msg = await sendUserMessage(page, 'Hello from fork test!');

    await clickMessageAction(page, msg, 'Fork at this message');

    // The new fork should appear in the chat list and become active
    await expect(page.locator('.chat-list')).toContainText('Fork of');
    await expect(page.locator('.chat-view')).toBeVisible();
  });
});
