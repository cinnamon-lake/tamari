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

// Minimal 1x1 transparent PNG in base64
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Attachments', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('uploads an image attachment and sends it with a message', async ({ page }) => {
    const charName = uniqueName('Attachment Character');
    await createCharacterAndChat(page, charName);

    // Upload a PNG via the hidden file input in the message input area.
    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });

    // The attachment preview should render.
    const preview = page.locator('.attachment-previews .attachment-preview');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Type a message and send it.
    const input = page.locator('.message-textarea');
    await input.fill('Here is an image');
    await page.locator('.message-input-area .send-btn').click();
    await expect(input).toHaveValue('');

    // Wait for the user message and verify it carries the attachment.
    await expect(page.locator('.message-bubble')).toHaveCount(2, { timeout: 5000 });
    const userBubble = page.locator('.message-bubble.user').last();
    await expect(userBubble).toContainText('Here is an image');
    await expect(userBubble.locator('.message-attachments')).toBeVisible();
    await expect(userBubble.locator('.message-attachment-img')).toBeVisible();

    await expectNoAxeViolations(page);
  });

  test('removes an attachment preview before sending', async ({ page }) => {
    const charName = uniqueName('Attachment Remove Character');
    await createCharacterAndChat(page, charName);

    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });

    const preview = page.locator('.attachment-previews .attachment-preview');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Click the remove button on the preview.
    await preview.locator('button[aria-label="Remove attachment"]').click();
    await expect(preview).not.toBeVisible();

    await expectNoAxeViolations(page);
  });
});
