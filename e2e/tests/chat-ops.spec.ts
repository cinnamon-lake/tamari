import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { uniqueName } from '../helpers/names.js';

// Minimal 1x1 transparent PNG in base64
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Chat Operations', () => {
  test.beforeEach(async () => {
    await resetLlmRequests();
  });

  test('fork at a message branches the chat without touching the original', async ({ page, app }) => {
    const charName = uniqueName('Fork Char');
    await app.createCharacterAndChat({ name: charName, firstMes: 'Ready.' });

    await app.sendUserMessage('seq: one', { expectReply: true });
    await app.sendUserMessage('seq: two', { expectReply: true });
    await app.waitForBubbleCount(5); // greeting + 2 user + 2 assistant

    // Fork at the FIRST reply (nth(1) — the greeting is nth(0)): the fork
    // contains greeting + first turn + first reply.
    const firstReply = page.locator('.message-bubble.assistant').nth(1);
    await app.forkAt(firstReply);

    const forkItem = page.locator('.chat-item').filter({ hasText: 'Fork of' }).first();
    await forkItem.click();
    await app.waitForBubbleCount(3);
    await expect(app.lastBubble('user')).toContainText('seq: one');

    // The original chat is untouched. ('Fork of ...' contains the char name,
    // so exclude it explicitly — .first() would otherwise pick the fork.)
    const originalItem = page
      .locator('.chat-item')
      .filter({ hasText: charName })
      .filter({ hasNotText: 'Fork of' })
      .first();
    await originalItem.click();
    await app.waitForBubbleCount(5);
  });

  test('checkpoint create + restore rolls the chat back', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('CP Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('seq: one', { expectReply: true });
    await app.waitForBubbleCount(3);

    // Create a checkpoint at the current leaf.
    await page.locator('.chat-header button[title="Menu"]').click();
    await page.locator('.dropdown-item:has-text("Checkpoints")').click();
    const panel = page.locator('.modal:has(.modal-title:has-text("Checkpoints"))');
    await expect(panel).toBeVisible();
    await expectNoAxeViolations(page);
    await panel.locator('button:has-text("Create Checkpoint")').click();
    await page.locator('.modal-overlay:has(.modal)').click({ position: { x: 0, y: 0 } });
    await expect(panel).not.toBeVisible();

    // The new soft-fork chat is auto-selected on creation. Wait for that
    // auto-select to land (header shows '(checkpoint)'), THEN switch back —
    // re-selecting before the auto-select would let it yank the chat back.
    await expect(page.locator('.chat-header')).toContainText('(checkpoint)', { timeout: 5000 });
    const original = page
      .locator('.chat-item')
      .filter({ hasText: 'CP Char' })
      .filter({ hasNotText: '(checkpoint)' })
      .first();
    await original.click();
    await expect(page.locator('.chat-header')).not.toContainText('(checkpoint)');
    await app.waitForBubbleCount(3);

    // Keep talking — the checkpoint stays anchored to the earlier leaf.
    await app.sendUserMessage('seq: two', { expectReply: true });
    await app.sendUserMessage('seq: three', { expectReply: true });
    await app.waitForBubbleCount(7);

    // Restore: selects the soft-fork chat at the checkpoint leaf (3 bubbles).
    await page.locator('.chat-header button[title="Menu"]').click();
    await page.locator('.dropdown-item:has-text("Checkpoints")').click();
    await expect(panel.locator('.worldinfo-item')).toHaveCount(1, { timeout: 5000 });
    await panel.locator('button[title="Restore"]').first().click();
    await expect(panel).not.toBeVisible();
    await app.waitForBubbleCount(3);
    await expect(app.lastBubble('user')).toContainText('seq: one');
  });

  test('continue extends the last assistant reply', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('Cont Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('respond: Start', { expectReply: true });
    const reply = app.lastBubble('assistant');
    const beforeLen = (await app.lastAssistantText()).length;
    expect(beforeLen).toBeGreaterThan(0);

    await app.clickMessageAction(reply, 'Continue');
    // The continue streams onto the SAME message — wait for the text to grow.
    await expect
      .poll(async () => (await app.lastAssistantText()).length, { timeout: 15000 })
      .toBeGreaterThan(beforeLen);
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 15000 });
  });

  test('impersonate fills the composer with a generated draft', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('Imp Char'), firstMes: 'Ready.' });

    // A fresh chat's greeting is virtual (no DB message), and impersonate
    // needs a real message to impersonate from — send one first.
    await app.sendUserMessage('hello there', { expectReply: true });

    await page.locator('button[title="Impersonate"]').click();
    const input = app.messageInput();
    await expect(input).not.toHaveValue('', { timeout: 15000 });
    const draft = await input.inputValue();

    await app.sendUserMessage(draft, { expectReply: true });
    await expect(app.lastBubble('user')).toContainText(draft.slice(0, 20));
  });

  test('edits an attachment-only message and adds text', async ({ page, app }) => {
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

  test('deleting a message with replies is rejected with an error toast', async ({ page, app }) => {
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

  test('clicking a data-post-response button in a reply posts the response and generates', async ({ page, app }) => {
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
