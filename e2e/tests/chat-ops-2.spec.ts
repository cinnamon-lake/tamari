import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG in base64
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Chat Operations 2', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('edits an attachment-only message and adds text', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('AttachEdit Char'), firstMes: 'Ready.' });

    // Upload an image and send it with NO text.
    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    const beforeAssistant = await page.locator('.message-bubble.assistant').count();
    await page.locator('.message-input-area .send-btn').click();

    const userBubble = app.lastBubble('user');
    await expect(userBubble.locator('.message-attachment-img')).toBeVisible({ timeout: 5000 });

    // Let the triggered generation settle so the edit doesn't race the stream.
    await expect
      .poll(async () => await page.locator('.message-bubble.assistant').count(), {
        timeout: 60000,
        message: 'assistant reply appeared',
      })
      .toBeGreaterThan(beforeAssistant);
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });

    // Edit the message: the text area starts empty, saving pushes the text.
    await app.clickMessageAction(userBubble, 'Edit');
    const textarea = page.locator('.message-bubble.editing .edit-textarea');
    await expect(textarea).toHaveValue('');
    await textarea.fill('now with text');
    await page.locator('.message-bubble.editing button:has-text("Save")').click();

    await expect(userBubble.locator('.message-content')).toContainText('now with text', { timeout: 5000 });
    // The attachment survives the edit.
    await expect(userBubble.locator('.message-attachment-img')).toBeVisible();
  });

  test('deleting a message with replies is rejected with an error toast', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('DelChild Char'), firstMes: 'Ready.' });

    // Two full turns: the FIRST user message now has a child (the first
    // reply) and is not the chat head — deleteMessageAndRepair rejects it
    // with HAS_CHILDREN (deleting the head would contract the node instead).
    await app.sendUserMessage('seq: one', { expectReply: true });
    await app.sendUserMessage('seq: two', { expectReply: true });

    // Try to delete the mid-branch user message (confirmMessageDelete defaults on).
    const firstUser = page.locator('.message-bubble.user').first();
    await app.clickMessageAction(firstUser, 'Delete');
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();

    // The server rejects with HAS_CHILDREN and the message text lands in a toast.
    await expect(page.locator('.toast-container')).toContainText(
      'Cannot delete a message that has replies or swipes. Remove those first.',
      { timeout: 5000 },
    );
    // The message is still there.
    await expect(firstUser).toContainText('seq: one');
  });

  test('clicking a data-post-response button in a reply posts the response and generates', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('PostResp Char'), firstMes: 'Ready.' });

    // The mock replies with raw HTML; sanitization keeps button+data-post-response.
    await app.sendUserMessage('respond:<button data-post-response="attack">Attack</button>', {
      expectReply: true,
      userText: 'respond:',
    });

    const replyBubble = app.lastBubble('assistant');
    const postButton = replyBubble.locator('button[data-post-response="attack"]');
    await expect(postButton).toBeVisible({ timeout: 10000 });
    await expect(postButton).toHaveText('Attack');

    const beforeAssistant = await page.locator('.message-bubble.assistant').count();
    await postButton.click();

    // The attribute value is posted as the next user message...
    await expect(app.lastBubble('user')).toContainText('attack', { timeout: 5000 });
    // ...and a generation fires for it.
    await expect
      .poll(async () => await page.locator('.message-bubble.assistant').count(), {
        timeout: 60000,
        message: 'assistant reply appeared',
      })
      .toBeGreaterThan(beforeAssistant);
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
  });
});
