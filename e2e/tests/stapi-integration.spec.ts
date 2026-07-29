import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
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

  // Filter the character list so the target row is always reachable regardless of pagination.
  await page.locator('input[placeholder="Search characters..."]').fill(charName);

  const charRow = page.locator('.character-list li').filter({
    has: page.locator('.character-name', { hasText: charName }),
  });
  await charRow.waitFor({ state: 'visible' });
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

async function clickQuickReply(page: any, label: string) {
  const qrBtn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
  await expect(qrBtn).toBeVisible();
  await qrBtn.click();
}

// The StApi exposes many async functions. Inside a quick-reply Lua script those functions
// return JS Promise objects that can be awaited with :await(), so both fire-and-forget and
// promise-returning calls are usable from the browser UI.
test.describe.configure({ mode: 'serial' });

test.describe('StApi Integration', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('st.send appends a user message', async ({ page }) => {
    const label = uniqueName('StApi Send');
    const charName = uniqueName('StApi Character');
    const messageText = 'Hello from StApi integration test!';

    await createGlobalQuickReply(page, label, `st.send("${messageText}")`);
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    const userBubble = page.locator('.message-bubble.user').last();
    await expect(userBubble).toContainText(messageText, { timeout: 5000 });

    await expectNoAxeViolations(page);
  });

  test('st.cut removes the last message', async ({ page }) => {
    const label = uniqueName('StApi Cut');
    const charName = uniqueName('StApi Cut Character');

    await createGlobalQuickReply(page, label, 'st.cut(1)');
    await createCharacterAndChat(page, charName);

    // Send a user message so there is something to cut.
    const input = page.locator('.message-textarea');
    await input.fill('Cut me');
    await page.locator('.message-input-area .send-btn').click();
    await expect(input).toHaveValue('');
    await expect(page.locator('.message-bubble.user')).toContainText('Cut me', { timeout: 5000 });

    await clickQuickReply(page, label);
    // The user message should disappear, leaving only the greeting.
    await expect(page.locator('.message-bubble.user')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.message-bubble')).toHaveCount(1);

    await expectNoAxeViolations(page);
  });

  test('st.edit updates a specific message', async ({ page }) => {
    const label = uniqueName('StApi Edit');
    const charName = uniqueName('StApi Edit Character');

    await createGlobalQuickReply(
      page,
      label,
      'local msgs = st.get_messages(10):await() st.edit(msgs[#msgs].id, "Edited by StApi")',
    );
    await createCharacterAndChat(page, charName);

    const input = page.locator('.message-textarea');
    await input.fill('Edit me');
    await page.locator('.message-input-area .send-btn').click();
    await expect(input).toHaveValue('');
    await expect(page.locator('.message-bubble.user')).toContainText('Edit me', { timeout: 5000 });

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.user').last()).toContainText('Edited by StApi', {
      timeout: 5000,
    });

    await expectNoAxeViolations(page);
  });

  test('st.delete removes a specific message', async ({ page }) => {
    const label = uniqueName('StApi Delete');
    const charName = uniqueName('StApi Delete Character');

    await createGlobalQuickReply(
      page,
      label,
      'local msgs = st.get_messages(10):await() st.delete(msgs[#msgs].id)',
    );
    await createCharacterAndChat(page, charName);

    const input = page.locator('.message-textarea');
    await input.fill('Delete me');
    await page.locator('.message-input-area .send-btn').click();
    await expect(input).toHaveValue('');
    await expect(page.locator('.message-bubble.user')).toContainText('Delete me', { timeout: 5000 });

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.user')).toHaveCount(0, { timeout: 5000 });

    await expectNoAxeViolations(page);
  });

  test('st.rename_chat renames the active chat', async ({ page }) => {
    const label = uniqueName('StApi Rename');
    const charName = uniqueName('StApi Rename Character');
    const newName = uniqueName('Renamed by StApi');

    await createGlobalQuickReply(page, label, `st.rename_chat("${newName}")`);
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.chat-list')).toContainText(newName, { timeout: 5000 });

    await expectNoAxeViolations(page);
  });

  test('st.set_chat_metadata writes custom metadata', async ({ page }) => {
    const label = uniqueName('StApi Metadata');
    const charName = uniqueName('StApi Metadata Character');

    await createGlobalQuickReply(page, label, 'st.set_chat_metadata("scenario", "space station")');
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    // There is no visible indicator for metadata; verify the quick reply executes without errors
    // by checking the notification area does not contain a script error toast.
    await expect(page.locator('.toast-container')).not.toContainText('error', { timeout: 2000 });

    await expectNoAxeViolations(page);
  });

  test('st.set_author_note writes author note metadata', async ({ page }) => {
    const label = uniqueName('StApi AuthorNote');
    const charName = uniqueName('StApi AuthorNote Character');

    await createGlobalQuickReply(
      page,
      label,
      'st.set_author_note("Think carefully", { depth = 3, position = "before_prompt" })',
    );
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.toast-container')).not.toContainText('error', { timeout: 2000 });

    await expectNoAxeViolations(page);
  });

  test('st.setvar persists a chat-scoped variable', async ({ page }) => {
    const label = uniqueName('StApi SetVar');
    const charName = uniqueName('StApi SetVar Character');

    await createGlobalQuickReply(page, label, 'st.setvar("mood", "happy")');
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.toast-container')).not.toContainText('error', { timeout: 2000 });

    await expectNoAxeViolations(page);
  });

});
