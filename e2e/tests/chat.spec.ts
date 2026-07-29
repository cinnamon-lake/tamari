import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('selects a character and opens chat', async ({ page }) => {
    const charName = uniqueName('Chat Test Character');

    // Create a character
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(charName);
    // Description is the first textarea; First Message is the fourth
    await editor.locator('.textarea-input').nth(0).fill('A character created by e2e tests.');
    await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // Click on character name in sidebar to select it
    const chatCharRow = page.locator('.character-list li').filter({
      has: page.locator('.character-name', { hasText: charName }),
    });
    await chatCharRow.locator('.character-name').click();

    // Then click "New chat" on that character's row to create and open a chat
    await chatCharRow.locator('[title="New chat"]').click();

    // Wait for the chat to become active and the chat view to render messages
    await expect(page.locator('.chat-view')).toBeVisible();
    await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });
    await expectNoAxeViolations(page);
  });

  test('allows typing a message in the input', async ({ page }) => {
    const charName = uniqueName('Message Test Character');

    // Create a character
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(charName);
    // Description is the first textarea; First Message is the fourth
    await editor.locator('.textarea-input').nth(0).fill('A character created by e2e tests.');
    await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // Select character and start a new chat
    const msgCharRow = page.locator('.character-list li').filter({
      has: page.locator('.character-name', { hasText: charName }),
    });
    await msgCharRow.locator('.character-name').click();
    await msgCharRow.locator('[title="New chat"]').click();

    // Wait for the chat to become active and the input area to appear
    await expect(page.locator('.message-input-area')).toBeVisible();
    await expectNoAxeViolations(page);

    // Type a message and verify the textarea captures it
    const textarea = page.locator('.message-textarea');
    await textarea.fill('Hello from e2e tests!');
    await expect(textarea).toHaveValue('Hello from e2e tests!');

    // Verify the Send button is rendered and enabled
    const sendBtn = page.locator('.message-input-area .send-btn');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toBeEnabled();
  });

  test('character with no greeting gets an empty timeline and a working composer', async ({ page }) => {
    const charName = uniqueName('No Greeting Character');
    await configureMockBackend(page);
    const app = new App(page);

    try {
      // Create a character with a description but NO First Message.
      await page.locator('[title="Create character"]').click();
      const editor = page.locator('.character-editor-modal');
      await expect(editor).toBeVisible();
      await editor.locator('.text-input').first().fill(charName);
      await editor.locator('.textarea-input').nth(0).fill('A character with no greeting.');
      await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
      await editor.locator('[title="Close"]').click();
      await expect(editor).not.toBeVisible();

      // Start a chat: the timeline is empty (no virtual greeting bubble).
      const row = page.locator('.character-list li').filter({
        has: page.locator('.character-name', { hasText: charName }),
      });
      await row.locator('.character-name').click();
      await row.locator('[title="New chat"]').click();
      await expect(page.locator('.chat-view')).toBeVisible();
      await expect(page.locator('.message-bubble')).toHaveCount(0);

      // Regression: Send used to dead-end here (materialize promise never
      // resolved). Now the message posts and the mock LLM replies.
      await app.sendUserMessage('seq:Hello there.', { expectReply: true });
      await app.waitForAssistantText(/Turn \d+/);
    } finally {
      await resetBackendConfig(page);
    }
  });
});
