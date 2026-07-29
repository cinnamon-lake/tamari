/**
 * Stop / Continue generation flows against the deterministic mock LLM.
 *
 * Covers GenerationService.handleStop (abort mid-stream, partial text kept,
 * chat lock released), the auto-continue-on-length loop
 * (GenerationService.executeGeneration step 6), the Quick Continue quick
 * action (action.continue -> assistant prefill), and Quick Impersonate
 * (action.impersonate -> composer draft).
 *
 * Mock selectors used (see fixtures/mockLlmServer.ts header):
 *   slow:<ms>:<text>   -> per-chunk delay, unlocks deterministic Stop tests
 *   length:<text>      -> reply with a 'length' finish reason
 *   respond:<text>     -> fixed reply
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Stop and Continue', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // The e2e server is shared across specs — pin the settings these tests
    // depend on to a known state before touching anything else.
    await setSetting(page, 'autoContinueEnabled', false);
    await setSetting(page, 'quickContinue', false);
    await setSetting(page, 'quickImpersonate', false);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await setSetting(page, 'autoContinueEnabled', false);
    await setSetting(page, 'quickContinue', false);
    await setSetting(page, 'quickImpersonate', false);
    await resetBackendConfig(page);
  });

  test('stop mid-stream halts generation, keeps partial text, releases the lock', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Stop Character');
    await app.createCharacterAndChat({ name: charName, description: 'Stop test character.', firstMes: 'Hello from Stop !' });

    // ~100 chars at 150ms/char => ~15s of streaming; plenty of time to stop.
    const fullText =
      'streamed partial reply that keeps going and going with a long deterministic tail ENDMARKER';
    await app.sendUserMessage(`slow:150:${fullText}`);

    // The send button swaps to a danger Stop button while streaming.
    const stopBtn = page.locator('.message-input-area .send-btn.btn-danger');
    await expect(stopBtn).toBeVisible({ timeout: 10000 });

    // Wait until some partial text has actually streamed into the bubble.
    const bubble = app.lastBubble('assistant');
    await expect(bubble).toHaveClass(/streaming/, { timeout: 10000 });
    await expect(bubble.locator('.message-content')).toContainText('streamed partial', { timeout: 10000 });

    await stopBtn.click();

    // Streaming halts: streaming class gone, send button back to primary.
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.message-input-area .send-btn.btn-primary')).toBeVisible({ timeout: 10000 });

    // Partial text remains, the un-streamed tail never arrives, no error toast.
    await expect(bubble.locator('.message-content')).toContainText('streamed partial');
    await expect(bubble.locator('.message-content')).not.toContainText('ENDMARKER');
    await expect(page.locator('.toast-error')).toHaveCount(0);

    // The generation lock is released: the next send generates normally.
    await app.sendUserMessage('respond:lock released', { expectReply: true });
    await app.waitForAssistantText('lock released');
  });

  test('auto-continue fires extra LLM requests for a short length-finished reply', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('AutoContinue Character');
    await app.createCharacterAndChat({ name: charName, description: 'Auto-continue test character.', firstMes: 'Hello from Auto-continue !' });

    await setSetting(page, 'autoContinueEnabled', true);
    await setSetting(page, 'autoContinueTargetLength', 400);

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('length:chunk one ');

    // Auto-continue: the first reply is shorter than the target length, so the
    // service calls handleContinue — at least one more LLM request must fire.
    await waitForNextLlmRequest(before + 1, 20000);

    // Let the whole continue chain settle (max depth 3 on top of the initial call).
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('.message-input-area .send-btn.btn-primary')).toBeVisible({ timeout: 10000 });

    // The mock answers every continuation with the same selector reply, so the
    // continued bubble ends up containing the chunk more than once.
    const text = await app.lastAssistantText();
    const occurrences = text.split('chunk one').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    // Everything landed in a single assistant bubble (continued, not new turns).
    await expect(page.locator('.message-bubble.assistant')).toHaveCount(2); // greeting + reply
    await expect(page.locator('.toast-error')).toHaveCount(0);
  });

  test('quick continue sends an assistant prefill and extends the same bubble', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QuickContinue Character');
    await app.createCharacterAndChat({ name: charName, description: 'Quick continue test character.', firstMes: 'Hello from Quick continue !' });

    await setSetting(page, 'quickContinue', true);

    await app.sendUserMessage('respond:short reply', { expectReply: true });
    await app.waitForAssistantText('short reply');
    await expect(page.locator('.message-bubble.assistant')).toHaveCount(2); // greeting + reply

    const before = (await getLastLlmRequest()).count;
    await page.locator('button[title="Quick Continue"]').click();

    // The continuation request ends with the assistant message being continued
    // (prefill), not with a user message.
    const cap = await waitForNextLlmRequest(before);
    const messages = (cap.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('assistant');

    // The mock answers the continuation with the same selector reply; it is
    // appended to the same bubble instead of creating a new message.
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    const text = await app.lastAssistantText();
    const occurrences = text.split('short reply').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.message-bubble.assistant')).toHaveCount(2);
  });

  test('quick impersonate fills the composer with the generated draft', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QuickImpersonate Character');
    await app.createCharacterAndChat({ name: charName, description: 'Quick impersonate test character.', firstMes: 'Hello from Quick impersonate !' });

    await setSetting(page, 'quickImpersonate', true);

    // A brand-new chat is virtual until the first send — materialize it so the
    // server-side handleImpersonate finds an activeChildId to impersonate from.
    await app.sendUserMessage('respond:draft words', { expectReply: true });
    await app.waitForAssistantText('draft words');

    const before = (await getLastLlmRequest()).count;
    await page.locator('button[title="Quick Impersonate"]').click();

    // Impersonation runs a generation and delivers it as a composer draft
    // instead of a chat message.
    await waitForNextLlmRequest(before);
    await expect(app.messageInput()).not.toHaveValue('', { timeout: 10000 });

    // No new chat messages were added — still greeting + the one reply.
    await expect(page.locator('.message-bubble.assistant')).toHaveCount(2);
  });
});
