import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Chat Operations', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('fork at a message branches the chat without touching the original', async ({ page }) => {
    const app = new App(page);
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

  test('checkpoint create + restore rolls the chat back', async ({ page }) => {
    const app = new App(page);
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

  test('continue extends the last assistant reply', async ({ page }) => {
    const app = new App(page);
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

  test('impersonate fills the composer with a generated draft', async ({ page }) => {
    const app = new App(page);
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
});
