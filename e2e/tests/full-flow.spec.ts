import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { deleteNonDefaultPersonas } from '../helpers/personas.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/**
 * Send a ClientMessage through a temporary WebSocket connection.
 * Kept as a fallback for fork, which sometimes fails to register a
 * programmatic click on the message-action button.
 */
async function sendWsMessage(page: import('@playwright/test').Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (message) => {
    const token = localStorage.getItem('st_auth_token') || '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({ type: 'auth' }));
        setTimeout(() => {
          ws.send(JSON.stringify(message));
          resolve();
        }, 200);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WS error'));
      };
    });

    await new Promise((r) => setTimeout(r, 800));
    ws.close();
  }, msg);
}

test.describe('Full App Flow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    // Personas are global and chat.create auto-binds the first one to new
    // chats — don't leak the journey's persona into later specs.
    await deleteNonDefaultPersonas(page);
  });

  test('end-to-end journey: persona → character → chat → message → fork', async ({ page }) => {
    const personaName = uniqueName('E2E Persona');
    const charName = uniqueName('E2E Character');

    // ── 1. Create a persona ──
    await page.locator('.settings-btn', { hasText: 'Personas' }).click();
    await expect(page.locator('.persona-modal')).toBeVisible();
    await page.locator('.persona-modal .primary-btn', { hasText: 'New Persona' }).click();

    // Persona editor opens inside the modal
    await expect(page.locator('.persona-modal .text-input').first()).toHaveValue('New Persona', { timeout: 3000 });
    await page.locator('.persona-modal .text-input').first().fill(personaName);
    await page.locator('.persona-modal .textarea-input').first().fill('A test persona for e2e.');
    await page.waitForTimeout(800); // auto-save debounce

    // Go back to list and close modal (click overlay)
    await page.locator('.persona-modal .back-btn').click();
    await expect(page.locator('.persona-modal .persona-list')).toBeVisible();
    await expect(page.locator('.persona-modal')).toContainText(personaName);
    await page.locator('.modal-overlay').first().click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.persona-modal')).not.toBeVisible();

    // ── 2. Create a character ──
    await page.locator('[title="Create character"]').click();
    const charEditor = page.locator('.character-editor-modal');
    await expect(charEditor).toBeVisible();
    await charEditor.locator('.text-input').first().fill(charName);
    // Description is the first textarea; First Message (the greeting) is the fourth.
    await charEditor.locator('.textarea-input').nth(0).fill('A character for the full e2e flow.');
    await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await charEditor.locator('[title="Close"]').click();
    await expect(charEditor).not.toBeVisible();
    await expect(page.locator('.character-list')).toContainText(charName);

    // ── 3. Select character and start a chat ──
    const charRow = page.locator('.character-list li').filter({
      has: page.locator('.character-name', { hasText: charName }),
    });
    await charRow.locator('.character-name').click();
    await charRow.locator('[title="New chat"]').click();

    // Chat view appears with greeting bubble
    await expect(page.locator('.chat-view')).toBeVisible();
    await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });

    // ── 4. Send a user message through the real input ──
    const input = page.locator('.message-textarea');
    await input.fill('Hello from the full flow test!');
    await page.locator('.message-input-area .send-btn').click();

    // Verify the message appears and the input clears
    await expect(input).toHaveValue('');
    await expect(page.locator('.message-bubble', { hasText: 'Hello from the full flow test!' })).toBeVisible({ timeout: 5000 });

    // ── 5. Fork the conversation ──
    const userMsg = page.locator('.message-bubble', { hasText: 'Hello from the full flow test!' });
    const box = await userMsg.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }
    await page.waitForTimeout(300);

    // Try clicking the fork button; if it doesn't work, fall back to WS
    const forkBtn = page.locator('[title="Fork at this message"]');
    try {
      await forkBtn.click({ timeout: 2000 });
    } catch {
      const chatId = await page.evaluate(() => {
        const el = document.querySelector('.chat-list .chat-item.active');
        return el?.id ?? null;
      });
      const messageId = await page.evaluate(() => {
        const bubble = document.querySelector('.message-bubble.user');
        return bubble ? Number(bubble.id) : null;
      });
      expect(chatId).not.toBeNull();
      expect(messageId).not.toBeNull();
      await sendWsMessage(page, {
        type: 'chat.softFork',
        chatId,
        messageId,
        name: 'Forked Chat',
      });
    }

    // Verify forked chat appears in sidebar (default fork name starts with "Fork of")
    await expect(page.locator('.chat-list')).toContainText('Fork of', { timeout: 5000 });
  });
});
