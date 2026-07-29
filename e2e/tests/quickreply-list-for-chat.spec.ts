import { test, expect } from '../fixtures/base.js';
import { login, TEST_SECRET } from '../helpers/auth.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Reproduces docs/quality/audits/interface-audit-2026-07-20.md live bug #2:
// `quickreply.listForChat` is in ClientMessageSchema, the TS union, and has a
// dispatcher case (server/src/dispatcher.ts), and the client sends it whenever
// a chat becomes active (client/src/components/QuickReplyBar.tsx) — but it is
// MISSING from the WS handler registration lists in server/src/main.ts, so
// the bus finds zero handlers and silently drops it. Result: after a fresh
// page load, opening a chat never loads its quick replies into the bar.
//
// The quickreply.created broadcast path still works, so to isolate the list
// path the test creates the chat-scoped quick reply, then RELOADS the page
// (fresh client state, empty state.quickReplies — the auth snapshot carries
// no quick replies) and reopens the chat. The only thing that can populate
// the bar then is a quickreply.listed reply to quickreply.listForChat.
//
// EXPECTED TODAY: FAILS — the bar stays empty after reopening the chat.
test.describe('quickreply.listForChat (audit: dropped WS message)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('a chat-scoped quick reply appears in the bar when its chat is opened after reload', async ({ page }) => {
    const app = new App(page);
    const characterName = uniqueName('QR List Host');

    await app.createCharacterAndChat({
      name: characterName,
      firstMes: 'Ready.',
    });
    const chatId = await app.activeChatId();
    expect(chatId, 'active chat has a DOM id').toBeTruthy();

    // Create a chat-scoped quick reply through the bar's own editor.
    const label = uniqueName('Chat QR');
    await page.locator('.quick-reply-bar .quick-reply-add').click();
    const editor = page.locator('.qr-modal');
    await expect(editor).toBeVisible();
    await editor.locator('#qr-label').fill(label);
    await editor.locator('#qr-script').fill("return 'hi'");
    await editor.locator('#qr-scope').selectOption('chat');
    await editor.locator('.btn-primary').click();
    await expect(editor).not.toBeVisible();

    // Sanity: the quickreply.created broadcast renders the button immediately,
    // proving the quick reply exists and belongs to this chat.
    const qrButton = page.locator('.quick-reply-bar .quick-reply-btn .qr-label', { hasText: label });
    await expect(qrButton).toBeVisible({ timeout: 10000 });

    // Reload: fresh client state (state.quickReplies = []). The auth token
    // persists in localStorage; re-authenticate only if the modal shows.
    await page.reload();
    const authInput = page.locator('[data-testid="auth-input"]');
    if (await authInput.isVisible({ timeout: 3000 })) {
      await authInput.fill(TEST_SECRET);
      await page.locator('[data-testid="auth-submit"]').click();
    }
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });

    // Reopen the chat. QuickReplyBar's effect sends quickreply.listForChat —
    // dropped server-side today, so quickreply.listed never arrives.
    await app.selectChatById(chatId!);

    await expect(qrButton).toBeVisible({ timeout: 10000 });
  });
});
